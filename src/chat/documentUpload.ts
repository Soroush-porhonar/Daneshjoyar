import path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { downloadBaleDocument, sendMessage } from "../bale.js";
import type { BaleDocument } from "../bale.js";
import {
  duplicateDocumentText,
  fileProcessedText,
  FILE_RECEIVED_TEXT,
  FILE_TOO_LARGE_TEXT,
  NOT_A_PDF_TEXT,
  ocrProgressText,
  ocrStartedText,
} from "../messages.js";
import { config } from "../config.js";
import { findDuplicateDocument } from "../db/documents.js";
import { findOrCreateUser } from "../db/users.js";
import { DuplicateDocumentError, getDocumentErrorText, getErrorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { ingestPdf } from "../rag/ingest.js";
import { documentsButton } from "../bot/buttons.js";

/** Tells the user the file is already there; offers the list when it is ready. */
async function sendDuplicateNotice(
  chatId: number,
  filename: string,
  stillProcessing: boolean,
): Promise<void> {
  await sendMessage(
    chatId,
    duplicateDocumentText(filename, stillProcessing),
    stillProcessing ? undefined : { inline: documentsButton() },
  );
}

function isPdf(document: BaleDocument, filename: string): boolean {
  return (
    filename.toLowerCase().endsWith(".pdf") ||
    document.mime_type === "application/pdf"
  );
}

/**
 * Downloads and ingests an uploaded PDF.
 * Returns false when the update should be retried.
 */
export async function handleDocument(
  chatId: number,
  document: BaleDocument,
): Promise<boolean> {
  try {
    const filename = document.file_name ?? "document.pdf";

    if (!isPdf(document, filename)) {
      await sendMessage(chatId, NOT_A_PDF_TEXT);
      return true;
    }

    if (
      document.file_size !== undefined &&
      document.file_size > config.bale.maxFileSize
    ) {
      await sendMessage(chatId, FILE_TOO_LARGE_TEXT);
      return true;
    }

    const user = await findOrCreateUser(String(chatId));
    const name = path.basename(filename);

    // Same file (name and size) already uploaded? Bale reports the size, so
    // this is checked before downloading anything.
    if (document.file_size !== undefined) {
      const existing = await findDuplicateDocument(user.id, name, document.file_size);
      if (existing) {
        await sendDuplicateNotice(chatId, name, existing.status !== "completed");
        return true;
      }
    }

    await sendMessage(chatId, FILE_RECEIVED_TEXT);

    const downloaded = await downloadBaleDocument(document);
    const fileSize = document.file_size ?? (await stat(downloaded.filePath)).size;

    // Without a size from Bale, check now that the file is here.
    if (document.file_size === undefined) {
      const existing = await findDuplicateDocument(user.id, downloaded.filename, fileSize);
      if (existing) {
        await unlink(downloaded.filePath).catch(() => {});
        await sendDuplicateNotice(chatId, downloaded.filename, existing.status !== "completed");
        return true;
      }
    }

    let result;

    try {
      result = await ingestPdf(
        user.id,
        downloaded.filename,
        downloaded.filePath,
        async ({ ocrDone, ocrTotal, skipped }) => {
          await sendMessage(
            chatId,
            ocrDone === 0
              ? ocrStartedText(
                  ocrTotal,
                  skipped,
                  Math.max(1, Math.round((ocrTotal * config.ocr.secondsPerPage) / 60)),
                )
              : ocrProgressText(ocrDone, ocrTotal),
          );
        },
        fileSize,
      );
    } catch (error: unknown) {
      // The same file sent twice in quick succession: the database caught it.
      if (error instanceof DuplicateDocumentError) {
        await unlink(downloaded.filePath).catch(() => {});
        await sendDuplicateNotice(chatId, downloaded.filename, true);
        return true;
      }
      throw error;
    }

    await sendMessage(chatId, fileProcessedText(result.ocrPages), { inline: documentsButton() });

    return true;
  } catch (error: unknown) {
    logger.error("Failed to process PDF document:", {
      chatId,
      errorMessage: getErrorMessage(error),
      error,
    });

    try {
      await sendMessage(chatId, getDocumentErrorText(error));
      return true;
    } catch (sendError: unknown) {
      logger.error("Failed to send document error message:", {
        chatId,
        error: sendError,
      });
      return false;
    }
  }
}
