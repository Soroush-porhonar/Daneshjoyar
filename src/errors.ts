import { logger } from "./logger.js";
import {
  AI_UNAVAILABLE_TEXT,
  FILE_PROCESSING_FAILED_TEXT,
  FILE_TIMEOUT_TEXT,
  PDF_UNREADABLE_TEXT,
} from "./messages.js";

/** The Ollama service failed, was unreachable, or returned bad data. */
export class OllamaError extends Error {
  override name = "OllamaError";
}

export class OllamaTimeoutError extends OllamaError {
  override name = "OllamaTimeoutError";
}

/** The PDF could not be read or contained no usable text. */
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
  if (isTimeoutOrAbort(error)) {
    return FILE_TIMEOUT_TEXT;
  }

  if (error instanceof OllamaError || getErrorMessage(error).includes("ECONNREFUSED")) {
    return AI_UNAVAILABLE_TEXT;
  }

  if (error instanceof PdfExtractError) {
    return PDF_UNREADABLE_TEXT;
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
