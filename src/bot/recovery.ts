import { failInterruptedDocuments } from "../db/documents.js";
import { logger } from "../logger.js";

/**
 * Runs at startup, before the inbox sweeper: uploads interrupted by a crash
 * or restart are marked failed (otherwise they stay "processing" forever and
 * the retry is taken for a duplicate). The sweeper then retries their updates
 * and tells the student only if it gives up. Never stops the bot from starting.
 */
export async function recoverInterruptedUploads(): Promise<void> {
  try {
    for (const upload of await failInterruptedDocuments()) {
      logger.warn("Upload interrupted by a restart; the inbox will retry it:", upload);
    }
  } catch (error: unknown) {
    logger.error("Failed to recover interrupted uploads:", error);
  }
}
