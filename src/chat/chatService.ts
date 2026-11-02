import { removeButtons, sendMessage } from "../bale.js";
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
import type { AnswerTrace } from "../rag/answer.js";
import { createAnswerLog, getLastAnswerHits } from "../db/answerLogs.js";
import type { NewAnswerLog } from "../db/answerLogs.js";
import { feedbackButtons } from "../bot/feedback.js";
import { needsRewrite, rewriteQuestion } from "../rag/rewrite.js";
import { routeMessage } from "../rag/router.js";

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
  documentId: null,
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

  try {
    return await composeAnswer(session, text, signal);
  } finally {
    if (noticeId !== undefined) {
      try {
        await removeButtons(chatId, noticeId);
      } catch {
        // Not critical (e.g. already removed by the cancel press).
      }
    }
  }
}

/** Answers using documents when the router says so, otherwise as general chat. */
async function composeAnswer(
  { userId, conversationId }: Session,
  text: string,
  signal?: AbortSignal,
): Promise<Reply> {
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

  // A standalone question can be searched while the router decides (saves the
  // search time). Follow-ups are searched only after they are rewritten.
  const followUp = needsRewrite(text, previous);
  const prefetch = followUp ? undefined : prefetchCandidates(userId, text);
  const classification = await routeMessage(text, documentNames, previous);

  if (classification.route === "document") {
    const question = await rewriteQuestion(text, previous, signal);
    // A follow-up is usually about the pages of the previous answer, so its
    // chunks compete with the search results (the reranker decides).
    const search = followUp
      ? prefetchCandidates(userId, question, await getLastAnswerHits(userId).catch(() => null))
      : prefetch;
    const trace: AnswerTrace = {};
    const answer = await answerFromDocuments(
      userId,
      question,
      classification.retrievalMode,
      signal,
      search,
      trace,
    );

    return {
      answer,
      log: {
        question: text,
        rewrittenQuestion: question === text ? null : question,
        route: "document",
        retrievalMode: classification.retrievalMode,
        documentId: trace.documentId ?? null,
        context: (trace.context ?? []).map((chunk) => ({
          page: chunk.pageNumber,
          pageEnd: chunk.pageEnd ?? null,
          documentId: chunk.documentId,
          chunkIndex: chunk.chunkIndex,
          isHit: chunk.isHit,
        })),
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
