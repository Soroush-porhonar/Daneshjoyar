/**
 * Yes/no questions an upload waits on (roadmap Q3: a long scan is confirmed
 * before it takes the GPU for half an hour or more). The question is a
 * message with ✅/❌ buttons; the upload's work awaits the press. Kept in
 * memory: after a restart the inbox retries the upload, which asks again.
 */
import { randomBytes } from "node:crypto";
import { editMessageText, sendMessage } from "../bale.js";
import { confirmOcrButtons } from "../bot/buttons.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface Pending {
  chatId: number;
  resolve: (yes: boolean) => void;
}

const pending = new Map<string, Pending>();

/**
 * Asks `question` with ✅/❌ buttons and resolves with the answer; no answer
 * within config.limits.confirmTimeoutMs counts as no.
 */
export async function askConfirmation(chatId: number, question: string): Promise<boolean> {
  const token = randomBytes(4).toString("hex");
  const messageId = await sendMessage(chatId, question, { inline: confirmOcrButtons(token) });

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(token)) return;
      logger.info("[Confirm] No answer; taken as no", { chatId, token });
      if (messageId !== undefined) void editMessageText(chatId, messageId, question).catch(() => undefined);
      resolve(false);
    }, config.limits.confirmTimeoutMs);

    pending.set(token, {
      chatId,
      resolve: (yes) => {
        clearTimeout(timer);
        resolve(yes);
      },
    });
  });
}

/**
 * Delivers a button press. Returns false if the question is no longer
 * waiting (answered, timed out, or asked before a restart) or belongs to another chat.
 */
export function answerConfirmation(token: string, chatId: number, yes: boolean): boolean {
  const question = pending.get(token);
  if (!question || question.chatId !== chatId) return false;
  pending.delete(token);
  question.resolve(yes);
  return true;
}
