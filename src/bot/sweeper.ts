/**
 * Retries updates whose work failed or was cut off by a restart (roadmap
 * 8.9): before the inbox such a message was lost, because the poller had
 * already moved past it. Runs at startup and then every minute.
 *
 * - An upload is retried (Bale's file id stays valid; the failed copy does
 *   not count as a duplicate).
 * - A message or button press older than `maxAgeMs` is not answered late,
 *   nor one the student has followed with a newer message (retrying it would
 *   cancel the newer answer, and the newer one is often the same question).
 * - After `maxAttempts` the student is asked to send it again.
 */
import { sendMessage } from "../bale.js";
import type { BaleUpdate } from "../bale.js";
import { config } from "../config.js";
import { abandonUpdate, claimRetry, hasLaterMessage, listUnfinishedUpdates } from "../db/updates.js";
import type { InboxUpdate } from "../db/updates.js";
import { logger } from "../logger.js";
import { MESSAGE_NOT_ANSWERED_TEXT, uploadInterruptedText } from "../messages.js";
import { routeUpdate, runningUpdates } from "./dispatcher.js";

const chatOf = (update: BaleUpdate): number | undefined =>
  update.message?.chat.id ?? update.callback_query?.message?.chat.id;

/** When the student sent it: Bale's message date, else when the bot received it. */
const sentAt = (update: InboxUpdate): number =>
  update.payload.message?.date ? update.payload.message.date * 1000 : update.receivedAt.getTime();

/** What to tell the student when the bot gives up; null for a button press. */
function giveUpText(update: BaleUpdate): string | null {
  const message = update.message;
  if (!message) return null;
  if (message.document) return uploadInterruptedText(message.document.file_name ?? "PDF");
  if (message.photo) return uploadInterruptedText("عکس");
  return MESSAGE_NOT_ANSWERED_TEXT;
}

async function giveUp(update: InboxUpdate, reason: string, tell: boolean): Promise<void> {
  logger.warn("[Inbox] Giving up on an update", { updateId: update.updateId, attempts: update.attempts, reason });
  await abandonUpdate(update.updateId);

  const chatId = chatOf(update.payload);
  const text = giveUpText(update.payload);
  if (!tell || chatId === undefined || text === null) return;
  await sendMessage(chatId, text).catch((error: unknown) =>
    logger.error("[Inbox] Could not tell the student:", { updateId: update.updateId, error }),
  );
}

let sweeping = false;

/**
 * One pass over the unfinished updates. "received" ones count as cut off
 * after `staleMs`; at startup that is 0, since none can belong to this process.
 */
export async function sweepInbox(staleMs: number = config.inbox.staleMs): Promise<void> {
  if (sweeping) return;
  sweeping = true;

  try {
    const updates = await listUnfinishedUpdates(staleMs, runningUpdates());

    for (const update of updates) {
      const { payload } = update;
      const isUpload = Boolean(payload.message?.document || payload.message?.photo);
      const chatId = chatOf(payload);

      if (update.attempts >= config.inbox.maxAttempts) {
        await giveUp(update, "too many attempts", true);
      } else if (!isUpload && Date.now() - sentAt(update) > config.inbox.maxAgeMs) {
        await giveUp(update, "too old to answer now", true);
      } else if (payload.message?.text && chatId !== undefined && (await hasLaterMessage(chatId, update.updateId))) {
        await giveUp(update, "the student sent a newer message", false);
      } else if (await claimRetry(update.updateId, update.status)) {
        logger.info("[Inbox] Retrying an update", { updateId: update.updateId, attempt: update.attempts + 1 });
        await routeUpdate(payload);
      }
    }
  } catch (error: unknown) {
    logger.error("[Inbox] Sweep failed:", error);
  } finally {
    sweeping = false;
  }
}

/**
 * Sweeps once at startup, before polling starts, then every `sweepIntervalMs`;
 * resolves (with a function that stops it) after the first pass. Every
 * unfinished update at startup was cut off by the restart, so it is retried
 * at once: with the 2-minute wait, a student whose answer was cut off by a
 * crash re-asked before the retry came (kill test, 2026-11-14).
 */
export async function startSweeper(): Promise<() => void> {
  await sweepInbox(0);
  const timer = setInterval(() => void sweepInbox(), config.inbox.sweepIntervalMs);
  return () => clearInterval(timer);
}
