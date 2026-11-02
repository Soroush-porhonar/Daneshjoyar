import { sendMessage } from "../bale.js";
import { failInterruptedDocuments } from "../db/documents.js";
import { logger } from "../logger.js";
import { uploadInterruptedText } from "../messages.js";

/**
 * Runs at startup: uploads interrupted by a crash or restart are marked failed
 * (otherwise they stay "processing" forever and block sending the file again),
 * and their users are asked to send the file again. Bale does not resend the
 * upload: the poller had already moved past it. Never stops the bot from starting.
 */
export async function recoverInterruptedUploads(): Promise<void> {
  let interrupted;

  try {
    interrupted = await failInterruptedDocuments();
  } catch (error: unknown) {
    logger.error("Failed to recover interrupted uploads:", error);
    return;
  }

  for (const upload of interrupted) {
    logger.warn("Upload interrupted by a restart:", upload);

    try {
      await sendMessage(Number(upload.chatId), uploadInterruptedText(upload.filename));
    } catch (error: unknown) {
      logger.error("Failed to tell the user about an interrupted upload:", { ...upload, error });
    }
  }
}
