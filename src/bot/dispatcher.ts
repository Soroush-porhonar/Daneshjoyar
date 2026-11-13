import { sendMessage } from "../bale.js";
import type { BaleUpdate } from "../bale.js";
import { handleMessage } from "../chat/chatService.js";
import { handleDocument, handlePhoto } from "../chat/documentUpload.js";
import { finishUpdate, receiveUpdate } from "../db/updates.js";
import { logger } from "../logger.js";
import { cancelRequest, finishRequest, isShuttingDown, startRequest } from "./cancellation.js";
import { handleCallback } from "./callbacks.js";
import {
  NO_REQUEST_TO_CANCEL_TEXT,
  REQUEST_CANCELLED_TEXT,
  UNSUPPORTED_MESSAGE_TEXT,
} from "../messages.js";

/** Message content the bot can't read; it says so instead of staying silent. */
const UNSUPPORTED_CONTENT = [
  "sticker",
  "voice",
  "audio",
  "video",
  "video_note",
  "animation",
  "contact",
  "location",
] as const;

/** Updates whose work is running in this process (the sweeper leaves them alone). */
const running = new Set<number>();

export const runningUpdates = (): number[] => [...running];

/** Resolves when no background work is running, or after `ms`; true if all finished. */
export async function backgroundIdle(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return running.size === 0;
}

/**
 * Runs slow work (LLM calls, PDF ingestion) without blocking the polling loop,
 * and records how it ended: "done", or "failed" for the sweeper to retry.
 * Work cut off by a shutdown stays "received" and is retried after the restart.
 */
function runInBackground(
  updateId: number,
  work: () => Promise<boolean>,
  cleanup?: () => void,
): void {
  running.add(updateId);
  void (async () => {
    let ok = false;
    try {
      ok = await work();
      if (!ok) logger.error("Update handling failed:", updateId);
    } catch (error: unknown) {
      logger.error("Failed to process update:", { updateId, error });
    } finally {
      cleanup?.();
      running.delete(updateId);
      if (!isShuttingDown()) {
        await finishUpdate(updateId, ok).catch((error: unknown) =>
          logger.error("Failed to record the end of an update:", { updateId, error }),
        );
      }
    }
  })();
}

/**
 * Records a new update in the inbox, then routes it. An update seen before is
 * skipped: Bale delivers it again until the offset moves, and its retries
 * belong to the sweeper. Throws if the update could not be recorded, so the
 * poller stops the batch and asks for it again.
 */
export async function dispatchUpdate(update: BaleUpdate): Promise<void> {
  if (!(await receiveUpdate(update))) {
    logger.info("Skipping an update seen before:", update.update_id);
    return;
  }

  await routeUpdate(update);
}

/**
 * Hands an update recorded in the inbox to its handler (also the sweeper's
 * retries). Quick handlers run here; slow ones in the background.
 */
export async function routeUpdate(update: BaleUpdate): Promise<void> {
  // Quick work: recorded "done", or "failed" for the sweeper, right here.
  const quick = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await finishUpdate(update.update_id, true);
    } catch (error: unknown) {
      logger.error("Failed to handle update:", { updateId: update.update_id, error });
      await finishUpdate(update.update_id, false).catch(() => undefined);
    }
  };

  if (update.callback_query) {
    // A button press: quick, so it is handled right away.
    const callback = update.callback_query;
    await quick(() => handleCallback(callback));
    return;
  }

  const message = update.message;

  if (message?.document) {
    const { chat, document } = message;
    runInBackground(update.update_id, () => handleDocument(chat.id, document));
    return;
  }

  if (message?.photo && message.photo.length > 0) {
    const { chat, photo } = message;
    runInBackground(update.update_id, () => handlePhoto(chat.id, photo));
    return;
  }

  if (message?.text) {
    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/cancel") {
      const cancelled = cancelRequest(chatId);
      await quick(() => sendMessage(chatId, cancelled ? REQUEST_CANCELLED_TEXT : NO_REQUEST_TO_CANCEL_TEXT));
      return;
    }

    const controller = startRequest(chatId);

    runInBackground(
      update.update_id,
      () => handleMessage(chatId, text, controller.signal),
      () => finishRequest(chatId, controller),
    );
    return;
  }

  if (message && UNSUPPORTED_CONTENT.some((field) => message[field] !== undefined)) {
    await quick(() => sendMessage(message.chat.id, UNSUPPORTED_MESSAGE_TEXT));
    return;
  }

  // Nothing else to do (edits, service messages, ...).
  await quick(async () => undefined);
}
