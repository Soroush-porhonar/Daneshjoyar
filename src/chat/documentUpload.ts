import { runAs } from "../llm/scheduler.js";
import path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { downloadBaleDocument, sendMessage } from "../bale.js";
import type { BaleDocument, BalePhotoSize } from "../bale.js";
import {
  duplicateDocumentText,
  fileProcessedText,
  FILE_RECEIVED_TEXT,
  FILE_TOO_LARGE_TEXT,
  ocrConfirmText,
  ocrProgressText,
  ocrStartedText,
  PHOTO_RECEIVED_TEXT,
  UNSUPPORTED_FILE_TEXT,
  UPLOAD_IN_PROGRESS_TEXT,
} from "../messages.js";
import { config } from "../config.js";
import { findDuplicateDocument } from "../db/documents.js";
import { findOrCreateUser } from "../db/users.js";
import { DuplicateDocumentError, OcrDeclinedError, getDocumentErrorText, getErrorMessage } from "../errors.js";
import { askConfirmation } from "./confirmations.js";
import { logger } from "../logger.js";
import { documentKind } from "../rag/documentKind.js";
import { ingestDocument } from "../rag/ingest.js";
import { documentsButton } from "../bot/buttons.js";
import { wakeEnrichment } from "../bot/enrichmentWorker.js";

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

/** A name for a photo, which has none: its upload time in Iran, e.g. photo-2026-11-04-15-30-12.jpg. */
export function photoFilename(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `photo-${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}.jpg`;
}

/**
 * A photo sent as a photo (not as a file): Bale offers it in several sizes,
 * compressed; the largest is read like an uploaded image file.
 * Returns false when the update should be retried.
 */
export async function handlePhoto(
  chatId: number,
  sizes: BalePhotoSize[],
  now = new Date(),
): Promise<boolean> {
  const largest = sizes.reduce((best, size) =>
    size.width * size.height > best.width * best.height ? size : best,
  );
  logger.info(
    `[Upload] Photo from chat ${chatId}: ${largest.width}x${largest.height}` +
      (largest.file_size === undefined ? "" : `, ${Math.round(largest.file_size / 1024)} KB`),
  );

  return handleDocument(chatId, {
    file_id: largest.file_id,
    file_name: photoFilename(now),
    mime_type: "image/jpeg",
    ...(largest.file_size === undefined ? {} : { file_size: largest.file_size }),
  });
}

/** Chats with an upload being read now: one at a time per student (roadmap Q3). */
const uploading = new Set<number>();

/**
 * Downloads and ingests an uploaded PDF or image file, one per student at a
 * time: a second file meanwhile is refused with a message (several at once
 * would hold the GPU for each other and for everyone's answers).
 * Returns false when the update should be retried.
 */
export async function handleDocument(chatId: number, document: BaleDocument): Promise<boolean> {
  if (uploading.has(chatId)) {
    logger.info(`[Upload] Chat ${chatId} sent a file while another is being read; refused`);
    await sendMessage(chatId, UPLOAD_IN_PROGRESS_TEXT);
    return true;
  }

  uploading.add(chatId);
  try {
    return await processDocument(chatId, document);
  } finally {
    uploading.delete(chatId);
  }
}

async function processDocument(chatId: number, document: BaleDocument): Promise<boolean> {
  try {
    const kind = documentKind(document.file_name, document.mime_type);

    if (!kind) {
      logger.info(
        `[Upload] Unsupported file from chat ${chatId} (${document.mime_type})`,
      );
      await sendMessage(chatId, UNSUPPORTED_FILE_TEXT);
      return true;
    }

    const filename = document.file_name ?? (kind === "image" ? "photo.jpg" : "document.pdf");

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

    await sendMessage(chatId, kind === "image" ? PHOTO_RECEIVED_TEXT : FILE_RECEIVED_TEXT);

    const downloaded = await downloadBaleDocument({ ...document, file_name: filename });
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
      // OCR is the GPU queue's second class: students' answers go first.
      result = await runAs({ kind: "ocr" }, () => ingestDocument(
        user.id,
        downloaded.filename,
        downloaded.filePath,
        // A photo is one page, and PHOTO_RECEIVED_TEXT already gave the time.
        kind === "image" ? undefined : async ({ ocrDone, ocrTotal, skipped }) => {
          const minutes = Math.max(1, Math.round((ocrTotal * config.ocr.secondsPerPage) / 60));
          // A long scan holds the GPU for a long time: ask first (no answer within an hour = no).
          if (ocrDone === 0 && ocrTotal > config.limits.ocrConfirmPages) {
            if (!(await askConfirmation(chatId, ocrConfirmText(ocrTotal, minutes)))) {
              throw new OcrDeclinedError(`OCR of ${ocrTotal} pages declined`);
            }
          }
          await sendMessage(
            chatId,
            ocrDone === 0
              ? ocrStartedText(
                  ocrTotal,
                  skipped,
                  minutes,
                )
              : ocrProgressText(ocrDone, ocrTotal),
          );
        },
        fileSize,
        kind,
      ));
    } catch (error: unknown) {
      // The same file sent twice in quick succession: the database caught it.
      if (error instanceof DuplicateDocumentError) {
        await unlink(downloaded.filePath).catch(() => {});
        await sendDuplicateNotice(chatId, downloaded.filename, true);
        return true;
      }
      // A failed upload keeps no file (its row stays "failed"; a retry downloads again).
      await unlink(downloaded.filePath).catch(() => {});
      throw error;
    }

    wakeEnrichment();
    // A photo is always read by OCR: no need to say so.
    await sendMessage(chatId, fileProcessedText(kind === "image" ? 0 : result.ocrPages), {
      inline: documentsButton(),
    });

    return true;
  } catch (error: unknown) {
    logger.error("Failed to process uploaded document:", {
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
