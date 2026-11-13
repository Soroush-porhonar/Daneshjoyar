import { editMessageText, keepTyping, removeButtons, sendMessage } from "../bale.js";
import { plainMath } from "../rag/plainMath.js";
import type { Markup } from "../bale.js";
import { cancelButton } from "../bot/buttons.js";
import { parseCommand } from "../bot/commands/index.js";
import {
  PROCESSING_FAILED_TEXT,
  BUSY_TEXT,
  dailyLimitText,
  REQUEST_CANCELLED_TEXT,
  RESTARTING_TEXT,
  queuePlaceText,
  SAVE_MESSAGE_FAILED_TEXT,
  THINKING_DONE_TEXT,
  THINKING_NOTICE_TEXT,
} from "../messages.js";
import { config } from "../config.js";
import { findOrCreateConversation } from "../db/conversations.js";
import { listCompletedFilenames } from "../db/documents.js";
import { getRecentMessages, saveMessage } from "../db/messages.js";
import { findOrCreateUser } from "../db/users.js";
import { logDatabaseError } from "../errors.js";
import { askAI } from "../llm/generalChat.js";
import { logger } from "../logger.js";
import { answerFromDocuments, prefetchCandidates } from "../rag/answer.js";
import { answerDocumentInfo, isDocumentInfoQuestion } from "../rag/documentInfo.js";
import { answerTransform, isTransformRequest } from "../rag/transform.js";
import type { AnswerTrace } from "../rag/answer.js";
import { countQuestionsToday, createAnswerLog, getLastAnswerHits } from "../db/answerLogs.js";
import type { NewAnswerLog } from "../db/answerLogs.js";
import { feedbackButtons } from "../bot/feedback.js";
import { needsRewrite, rewriteQuestion } from "../rag/rewrite.js";
import { resolveRoute, routeMessage } from "../rag/router.js";
import type { MessageClassification } from "../rag/router.js";
import { activeQuestionCount, runAs, startQuestion } from "../llm/scheduler.js";
import type { JobContext } from "../llm/scheduler.js";
import { createLiveAnswer } from "./streamEditor.js";
import type { LiveAnswer } from "./streamEditor.js";

interface Session {
  userId: number;
  conversationId: number;
}

/** Sends a best-effort notice; returns false if even that failed. */
async function notify(chatId: number, text: string): Promise<boolean> {
  try {
    await sendMessage(chatId, text);
    return true;
  } catch (error: unknown) {
    logger.error("Failed to notify user:", { chatId, error });
    return false;
  }
}

type AnswerLogInfo = Omit<NewAnswerLog, "userId" | "answer" | "latencyMs">;

/** A reply, plus buttons for it and what to record when it answered a question. */
interface Reply {
  answer: string;
  markup?: Markup;
  log?: AnswerLogInfo;
  /** The streamed answer's messages, where the final text goes. */
  live?: LiveAnswer;
}

const chatLog = (question: string): AnswerLogInfo => ({
  question,
  rewrittenQuestion: null,
  route: "chat",
  retrievalMode: null,
  documentIds: [],
  context: [],
});

/**
 * Answers a plain-text message. While it works, a "thinking" notice with a
 * ⏹️ cancel button is shown. When streaming is on (config.stream) the notice
 * becomes the answer as it is written, and handleMessage puts the final text
 * and buttons into it. Otherwise, when the work ends, the notice is replaced
 * by a short line (done or cancelled), so no stale "press cancel" stays.
 */
async function answerQuestion(
  chatId: number,
  session: Session,
  text: string,
  signal?: AbortSignal,
): Promise<Reply> {
  // Too many questions at once: say so now rather than keep the student waiting minutes.
  if (activeQuestionCount() >= config.queue.maxActiveQuestions) {
    logger.warn("[Queue] Busy; question refused", { chatId, active: activeQuestionCount() });
    return { answer: BUSY_TEXT };
  }

  // Counted for the busy limit; background enrichment waits until no question is left (one GPU).
  const finished = startQuestion();
  let noticeId: number | undefined;
  try {
    noticeId = await sendMessage(chatId, THINKING_NOTICE_TEXT, { inline: cancelButton() });
  } catch (error: unknown) {
    finished();
    throw error;
  }
  const stopTyping = keepTyping(chatId);
  const live =
    noticeId !== undefined && config.stream.mode !== "off"
      ? createLiveAnswer(chatId, noticeId, { liveButtons: cancelButton() })
      : null;
  const onDelta = live
    ? (partial: string) => {
        stopTyping(); // the text itself shows that the bot is working
        live.update(partial);
      }
    : undefined;
  const job: JobContext = {
    kind: "answer",
    ...(noticeId === undefined ? {} : { onPosition: placeShower(chatId, noticeId, () => live?.started ?? false) }),
  };

  let answered = false;
  try {
    const reply = await runAs(job, () => composeAnswer(session, text, signal, onDelta));
    answered = true;
    const timings = {
      ...reply.log?.timings,
      ...(job.waitedMs ? { queueMs: job.waitedMs } : {}),
      ...(live?.firstTextMs === undefined ? {} : { firstTextMs: live.firstTextMs }),
    };
    // Bale shows LaTeX as raw text; formulas go out as Unicode.
    return {
      ...reply,
      answer: plainMath(reply.answer),
      ...(reply.log ? { log: { ...reply.log, timings } } : {}),
      ...(live ? { live } : {}),
    };
  } finally {
    finished();
    stopTyping();
    // Stopped by a shutdown: the inbox answers it after the restart, so it is not "cancelled".
    const stoppedText = signal?.reason === "shutdown" ? RESTARTING_TEXT : REQUEST_CANCELLED_TEXT;
    if (live && (signal?.aborted || !answered)) {
      await endLiveAnswer(chatId, live, signal?.aborted ? stoppedText : null);
    } else if (!live && noticeId !== undefined) {
      // Done or cancelled: the notice says so (editing the text also drops the button).
      // On a failure the error message follows, so only the button goes.
      const outcome = signal?.aborted ? stoppedText : answered ? THINKING_DONE_TEXT : null;
      try {
        await (outcome ? editMessageText(chatId, noticeId, outcome) : removeButtons(chatId, noticeId));
      } catch {
        // Not critical: the notice may already be gone; at least try to remove its button.
        if (outcome) await removeButtons(chatId, noticeId).catch(() => undefined);
      }
    }
  }
}

/**
 * Ends a streamed answer that will not be finished (cancelled or failed): the
 * text shown so far stays, followed by `line` (cancelled), or the notice says
 * `line` alone if nothing was shown yet. The cancel button goes either way.
 */
async function endLiveAnswer(chatId: number, live: LiveAnswer, line: string | null): Promise<void> {
  await live.stop();
  const lastId = live.messageIds.at(-1)!;
  const lastText = live.lastMessageText;
  try {
    if (line) await editMessageText(chatId, lastId, lastText ? `${lastText}\n\n${line}` : line);
    else await removeButtons(chatId, lastId);
  } catch {
    await removeButtons(chatId, lastId).catch(() => undefined);
  }
}

/**
 * Shows the student's place in the GPU queue on the thinking notice: only
 * when it changes, at most every placeEditIntervalMs (the latest place is
 * shown when the interval ends), never once the answer itself is on it.
 * Place 0 (the question's turn came) puts the thinking text back.
 */
function placeShower(chatId: number, noticeId: number, answerShown: () => boolean): (place: number) => void {
  let shownPlace = 0;
  let wanted = 0;
  let lastEditAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const show = () => {
    timer = null;
    if (answerShown() || wanted === shownPlace) return;
    const text = wanted === 0 ? THINKING_NOTICE_TEXT : queuePlaceText(wanted);
    shownPlace = wanted;
    lastEditAt = Date.now();
    // Only a hint: a failed edit must never reach the GPU queue that called this.
    void (async () => {
      try {
        await editMessageText(chatId, noticeId, text, cancelButton(), { retry: false });
      } catch {
        // ignored
      }
    })();
  };

  return (place) => {
    wanted = place;
    if (timer) return;
    // Back to the thinking text at once; places no more often than the interval.
    const wait = place === 0 ? 0 : Math.max(0, lastEditAt + config.queue.placeEditIntervalMs - Date.now());
    if (wait === 0) show();
    else timer = setTimeout(show, wait);
  };
}

/** What an answer drew on, and its generation numbers, for the answer log. */
function traceLog(trace: AnswerTrace): Pick<AnswerLogInfo, "documentIds" | "context" | "timings"> {
  const generation = trace.generation;
  return {
    ...(generation
      ? {
          timings: {
            generationMs: Math.round(generation.totalMs),
            promptTokens: generation.promptTokens,
            outputTokens: generation.outputTokens,
          },
        }
      : {}),
    documentIds: trace.documentIds ?? [],
    context: (trace.context ?? []).map((chunk) => ({
      page: chunk.pageNumber,
      pageEnd: chunk.pageEnd ?? null,
      documentId: chunk.documentId,
      chunkIndex: chunk.chunkIndex,
      isHit: chunk.isHit,
    })),
  };
}

/** Answers using documents when the router says so, otherwise as general chat. */
async function composeAnswer(
  { userId, conversationId }: Session,
  text: string,
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<Reply> {
  // File names only: listing enriched documents' titles and topics did not
  // change a route on 33 messages (100% either way) but cost 2 mode decisions
  // (route + mode 97% -> 91%, npm run eval:router -- --with-search).
  const documentNames = await listCompletedFilenames(userId);
  const history = await getRecentMessages(
    conversationId,
    config.rag.historyLimit,
  );

  if (documentNames.length === 0) {
    return { answer: await askAI(history, signal, onDelta), log: chatLog(text) };
  }

  // The current message is already saved, so it is the last history entry.
  const previous = history.slice(0, -1);

  // "Shorter", "in three sentences" right after an answer from the notes:
  // rewrite that answer from its own sources (no router, no search).
  const lastReply = previous.at(-1);
  const transformSources =
    lastReply?.role === "assistant" && isTransformRequest(text)
      ? await getLastAnswerHits(userId).catch(() => [])
      : [];
  if (lastReply && transformSources.length > 0) {
    const trace: AnswerTrace = {};
    const answer = await answerTransform(userId, text, lastReply.content, transformSources, {
      ...(signal ? { signal } : {}),
      ...(onDelta ? { onDelta } : {}),
      trace,
    });
    return {
      answer,
      log: { question: text, rewrittenQuestion: null, route: "transform", retrievalMode: null, ...traceLog(trace) },
    };
  }

  // The message is searched as typed while the router decides (saves the search
  // time for standalone questions, which most are).
  const prefetch = prefetchCandidates(userId, text);
  prefetch.catch(() => undefined); // may go unused (follow-ups); its failure is handled where it is awaited
  // A question about a document itself is recognised by a rule, without the router.
  const routed: MessageClassification = isDocumentInfoQuestion(text)
    ? { route: "document_info", retrievalMode: "focused", dependsOnHistory: false, standaloneQuestion: null }
    : await routeMessage(text, documentNames, previous);
  // The router decides whether the message depends on the conversation. The
  // length rule (needsRewrite) is only the fallback when it gave no decision: it
  // rewrote every short standalone question (20 of 20, eval:router 2026-11-12).
  const followUp = routed.dependsOnHistory ?? needsRewrite(text, previous);
  // If the search clearly found the answer, keep the notes (not for follow-ups:
  // "explain more" searched as typed says nothing).
  const classification =
    routed.route === "chat" && !followUp
      ? resolveRoute(routed, (await prefetch.catch(() => null))?.ranked[0]?.rerankScore)
      : routed;

  if (classification.route !== "chat") {
    const question = followUp
      ? (routed.standaloneQuestion ?? (await rewriteQuestion(text, previous, signal, true)))
      : text;
    if (followUp) logger.info("[RAG] Follow-up:", { rewritten: question !== text, byRouter: Boolean(routed.standaloneQuestion) });
    // A follow-up is usually about the pages of the previous answer, so its
    // chunks compete with the search results (the reranker decides).
    const search = followUp
      ? prefetchCandidates(userId, question, await getLastAnswerHits(userId).catch(() => null))
      : prefetch;
    const trace: AnswerTrace = {};
    const options = { ...(signal ? { signal } : {}), prefetch: search, trace, onDelta };
    // Questions about a document itself are answered from its profile and opening page.
    const answer =
      classification.route === "document_info"
        ? await answerDocumentInfo(userId, question, options)
        : await answerFromDocuments(userId, question, classification.retrievalMode, options);

    return {
      answer,
      log: {
        question: text,
        rewrittenQuestion: question === text ? null : question,
        route: classification.route,
        retrievalMode: classification.route === "document" ? classification.retrievalMode : null,
        ...traceLog(trace),
      },
    };
  }

  return { answer: await askAI(history, signal, onDelta), log: chatLog(text) };
}

/** Records an answer for review; returns its id, or null if logging failed (never blocks the reply). */
async function logAnswer(userId: number, reply: Reply, latencyMs: number): Promise<number | null> {
  if (!reply.log) return null;

  try {
    return await createAnswerLog({ ...reply.log, userId, answer: reply.answer, latencyMs });
  } catch (error: unknown) {
    logger.warn("Failed to log answer:", error);
    return null;
  }
}

/**
 * Handles one incoming text message end to end.
 * Returns false when the update should be retried.
 */
export async function handleMessage(
  chatId: number,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let session: Session;

  try {
    const user = await findOrCreateUser(String(chatId));
    const conversationId = await findOrCreateConversation(user.id);
    await saveMessage(conversationId, "user", text);
    session = { userId: user.id, conversationId };
  } catch (error: unknown) {
    logDatabaseError("save incoming message", error, { chatId });
    return notify(chatId, SAVE_MESSAGE_FAILED_TEXT);
  }

  let reply: Reply;
  const started = Date.now();

  try {
    const command = parseCommand(text);

    if (command) {
      const result = await command.handler({ chatId, userId: session.userId, args: command.args });
      if (typeof result !== "string" && result.forgotUser) {
        // "Delete my data": nothing is left to save the reply into or log it against.
        await sendMessage(chatId, result.text);
        return true;
      }
      reply =
        typeof result === "string"
          ? { answer: result }
          : { answer: result.text, ...(result.markup ? { markup: result.markup } : {}) };
    } else if ((await countQuestionsToday(session.userId)) >= config.limits.dailyQuestions) {
      // The daily limit keeps one student from holding the single GPU (roadmap Q3).
      logger.info("Daily question limit reached:", { chatId });
      reply = { answer: dailyLimitText(config.limits.dailyQuestions) };
    } else {
      reply = await answerQuestion(chatId, session, text, signal);
    }
  } catch (error: unknown) {
    if (signal?.aborted) {
      logger.info("Request cancelled:", { chatId });
      return true;
    }

    logger.error("Failed to handle message:", { chatId, error });
    return notify(chatId, PROCESSING_FAILED_TEXT);
  }

  try {
    await saveMessage(session.conversationId, "assistant", reply.answer);
  } catch (error: unknown) {
    logger.error("Failed to save assistant response:", error);
    if (reply.live) await endLiveAnswer(chatId, reply.live, null);
    return false;
  }

  // Answers to questions get 👍/👎 buttons; commands and errors do not.
  const logId = await logAnswer(session.userId, reply, Date.now() - started);

  const markup = logId === null ? reply.markup : { inline: feedbackButtons(logId) };

  // A streamed answer is finished in its own messages; if Bale refuses, it is sent anew.
  if (reply.live) {
    if (await reply.live.finish(reply.answer, markup && "inline" in markup ? markup.inline : undefined)) return true;
    await endLiveAnswer(chatId, reply.live, null);
  }

  try {
    await sendMessage(chatId, reply.answer, markup);
    return true;
  } catch (error: unknown) {
    logger.error("Failed to send Bale message:", error);
    return false;
  }
}
