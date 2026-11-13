/**
 * Yes/no questions that work waits on: a long scan before it takes the GPU
 * for half an hour or more (roadmap Q3), "delete my data" (8.10). The
 * question is a message with two buttons; the work awaits the press. Kept in
 * memory: after a restart the inbox retries the update, which asks again.
 */
import { randomBytes } from "node:crypto";
import { editMessageText, sendMessage } from "../bale.js";
import { confirmButtons } from "../bot/buttons.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface Pending {
  chatId: number;
  resolve: (yes: boolean) => void;
}

const pending = new Map<string, Pending>();

interface ConfirmationOptions {
  /** Button labels; the long-scan ones by default. */
  yes?: string;
  no?: string;
  /** No answer within this counts as no (default config.limits.confirmTimeoutMs). */
  timeoutMs?: number;
}

/** Asks `question` with yes/no buttons and resolves with the answer; no answer in time counts as no. */
export async function askConfirmation(
  chatId: number,
  question: string,
  { yes, no, timeoutMs = config.limits.confirmTimeoutMs }: ConfirmationOptions = {},
): Promise<boolean> {
  const token = randomBytes(4).toString("hex");
  const messageId = await sendMessage(chatId, question, { inline: confirmButtons(token, yes, no) });

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(token)) return;
      logger.info("[Confirm] No answer; taken as no", { chatId, token });
      if (messageId !== undefined) void editMessageText(chatId, messageId, question).catch(() => undefined);
      resolve(false);
    }, timeoutMs);

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
