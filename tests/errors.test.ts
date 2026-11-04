import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OllamaError,
  OllamaTimeoutError,
  PdfExtractError,
  getDocumentErrorText,
} from "../src/errors.js";
import {
  AI_UNAVAILABLE_TEXT,
  FILE_PROCESSING_FAILED_TEXT,
  FILE_TIMEOUT_TEXT,
  FILE_UNREADABLE_TEXT,
} from "../src/messages.js";
import {
  clearPendingDeletion,
  getPendingDeletion,
  setPendingDeletion,
} from "../src/bot/pendingDelete.js";

describe("getDocumentErrorText", () => {
  it.each([
    ["an Ollama timeout", new OllamaTimeoutError("slow"), FILE_TIMEOUT_TEXT],
    ["a fetch timeout", new DOMException("slow", "TimeoutError"), FILE_TIMEOUT_TEXT],
    ["a cancellation", new DOMException("stop", "AbortError"), FILE_TIMEOUT_TEXT],
    ["an Ollama failure", new OllamaError("500"), AI_UNAVAILABLE_TEXT],
    ["Ollama not running", new Error("connect ECONNREFUSED 127.0.0.1:11434"), AI_UNAVAILABLE_TEXT],
    ["an unreadable PDF", new PdfExtractError("bad pdf"), FILE_UNREADABLE_TEXT],
    ["anything else", new Error("disk full"), FILE_PROCESSING_FAILED_TEXT],
    ["a non-Error value", "weird", FILE_PROCESSING_FAILED_TEXT],
  ])("maps %s to the right message", (_name, error, expected) => {
    expect(getDocumentErrorText(error)).toBe(expected);
  });
});

describe("pending deletion", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearPendingDeletion(1);
  });

  it("remembers the document waiting for confirmation", () => {
    setPendingDeletion(1, 5);

    expect(getPendingDeletion(1)).toBe(5);
    expect(getPendingDeletion(2)).toBeNull();
  });

  it("expires after one minute", () => {
    vi.useFakeTimers();
    setPendingDeletion(1, 5);

    vi.advanceTimersByTime(59_000);
    expect(getPendingDeletion(1)).toBe(5);

    vi.advanceTimersByTime(2_000);
    expect(getPendingDeletion(1)).toBeNull();
  });

  it("can be cleared", () => {
    setPendingDeletion(1, 5);
    clearPendingDeletion(1);

    expect(getPendingDeletion(1)).toBeNull();
  });
});
