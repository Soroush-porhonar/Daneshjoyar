import { logger } from "./logger.js";
import {
  AI_UNAVAILABLE_TEXT,
  FILE_PROCESSING_FAILED_TEXT,
  FILE_TIMEOUT_TEXT,
  FILE_UNREADABLE_TEXT,
  OCR_DECLINED_TEXT,
} from "./messages.js";

/** The Ollama service failed, was unreachable, or returned bad data. */
export class OllamaError extends Error {
  override name = "OllamaError";
}

export class OllamaTimeoutError extends OllamaError {
  override name = "OllamaTimeoutError";
}

/** Bale refused a call; on a rate limit (429) `retryAfterSeconds` says how long to wait. */
export class BaleApiError extends Error {
  override name = "BaleApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

/** The student declined reading a long scan (or did not answer). */
export class OcrDeclinedError extends Error {
  override name = "OcrDeclinedError";
}

/** The PDF or image could not be read or contained no usable text. */
export class PdfExtractError extends Error {
  override name = "PdfExtractError";
}

/** The user already has this file (same name and size). */
export class DuplicateDocumentError extends Error {
  override name = "DuplicateDocumentError";
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isTimeoutOrAbort(error: unknown): boolean {
  return (
    error instanceof OllamaTimeoutError ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

export function getDocumentErrorText(error: unknown): string {
  if (error instanceof OcrDeclinedError) {
    return OCR_DECLINED_TEXT;
  }

  if (isTimeoutOrAbort(error)) {
    return FILE_TIMEOUT_TEXT;
  }

  if (error instanceof OllamaError || getErrorMessage(error).includes("ECONNREFUSED")) {
    return AI_UNAVAILABLE_TEXT;
  }

  if (error instanceof PdfExtractError) {
    return FILE_UNREADABLE_TEXT;
  }

  return FILE_PROCESSING_FAILED_TEXT;
}

export function logDatabaseError(
  operation: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  logger.error(`Database operation failed: ${operation}`, {
    ...context,
    error,
  });
}
