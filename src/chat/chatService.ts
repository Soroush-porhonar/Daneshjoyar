import { removeButtons, sendMessage } from "../bale.js";
import { plainMath } from "../rag/plainMath.js";
import type { Markup } from "../bale.js";
import { cancelButton } from "../bot/buttons.js";
import { parseCommand } from "../bot/commands/index.js";
import {
  PROCESSING_FAILED_TEXT,
  SAVE_MESSAGE_FAILED_TEXT,
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
import { createAnswerLog, getLastAnswerHits } from "../db/answerLogs.js";
import type { NewAnswerLog } from "../db/answerLogs.js";
import { feedbackButtons } from "../bot/feedback.js";
import { needsRewrite, rewriteQuestion } from "../rag/rewrite.js";
import { resolveRoute, routeMessage } from "../rag/router.js";
import type { MessageClassification } from "../rag/router.js";
import { startForegroundWork } from "../llm/priority.js";

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
 * ⏹️ cancel button is shown; the button is removed when the work ends.
 */
async function answerQuestion(
  chatId: number,
  session: Session,
  text: string,
  signal?: AbortSignal,
): Promise<Reply> {
  const noticeId = await sendMessage(chatId, THINKING_NOTICE_TEXT, { inline: cancelButton() });
  // Background enrichment pauses until this answer is done (one GPU).
  const finished = startForegroundWork();

  try {
    const reply = await composeAnswer(session, text, signal);
    // Bale shows LaTeX as raw text; formulas go out as Unicode.
    return { ...reply, answer: plainMath(reply.answer) };
  } finally {
    finished();
    if (noticeId !== undefined) {
      try {
        await removeButtons(chatId, noticeId);
      } catch {
        // Not critical (e.g. already removed by the cancel press).
      }
    }
  }
}

/** What an answer drew on, for the answer log. */
function traceLog(trace: AnswerTrace): Pick<AnswerLogInfo, "documentIds" | "context"> {
  return {
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
    return { answer: await askAI(history, signal), log: chatLog(text) };
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
    const options = { ...(signal ? { signal } : {}), prefetch: search, trace };
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

  return { answer: await askAI(history, signal), log: chatLog(text) };
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
      reply = typeof result === "string" ? { answer: result } : { answer: result.text, markup: result.markup };
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
    return false;
  }

  // Answers to questions get 👍/👎 buttons; commands and errors do not.
  const logId = await logAnswer(session.userId, reply, Date.now() - started);

  const markup = logId === null ? reply.markup : { inline: feedbackButtons(logId) };

  try {
    await sendMessage(chatId, reply.answer, markup);
    return true;
  } catch (error: unknown) {
    logger.error("Failed to send Bale message:", error);
    return false;
  }
}
