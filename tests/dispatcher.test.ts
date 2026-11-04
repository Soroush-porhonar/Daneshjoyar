import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaleUpdate } from "../src/bale.js";

// Replace everything the dispatcher talks to (DB, Bale, handlers) with fakes.
vi.mock("../src/db/updates.js", () => ({
  isUpdateProcessed: vi.fn(),
  markUpdateProcessed: vi.fn(),
}));
vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../src/chat/chatService.js", () => ({ handleMessage: vi.fn() }));
vi.mock("../src/chat/documentUpload.js", () => ({ handleDocument: vi.fn(), handlePhoto: vi.fn() }));
vi.mock("../src/bot/feedback.js", () => ({ handleFeedback: vi.fn() }));

const { dispatchUpdate } = await import("../src/bot/dispatcher.js");
const { isUpdateProcessed, markUpdateProcessed } = await import("../src/db/updates.js");
const { sendMessage } = await import("../src/bale.js");
const { handleMessage } = await import("../src/chat/chatService.js");
const { handleDocument, handlePhoto } = await import("../src/chat/documentUpload.js");
const { logger } = await import("../src/logger.js");
const { NO_REQUEST_TO_CANCEL_TEXT, REQUEST_CANCELLED_TEXT, UNSUPPORTED_MESSAGE_TEXT } = await import(
  "../src/messages.js"
);

/** Lets the fire-and-forget background work finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const textUpdate = (updateId: number, text: string, chatId = 7): BaleUpdate => ({
  update_id: updateId,
  message: { chat: { id: chatId }, text },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.mocked(isUpdateProcessed).mockResolvedValue(false);
  vi.mocked(handleMessage).mockResolvedValue(true);
  vi.mocked(handleDocument).mockResolvedValue(true);
  vi.mocked(handlePhoto).mockResolvedValue(true);
});

describe("dispatchUpdate", () => {
  it("skips updates that were already processed", async () => {
    vi.mocked(isUpdateProcessed).mockResolvedValue(true);

    await dispatchUpdate(textUpdate(1, "سلام"));
    await flush();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(markUpdateProcessed).not.toHaveBeenCalled();
  });

  it("handles a text message and marks it processed on success", async () => {
    await dispatchUpdate(textUpdate(2, "  سلام  "));
    await flush();

    expect(handleMessage).toHaveBeenCalledWith(7, "سلام", expect.any(AbortSignal));
    expect(markUpdateProcessed).toHaveBeenCalledWith(2);
  });

  it("does not mark the update processed when the handler reports failure", async () => {
    vi.mocked(handleMessage).mockResolvedValue(false);

    await dispatchUpdate(textUpdate(3, "سلام"));
    await flush();

    expect(markUpdateProcessed).not.toHaveBeenCalled();
  });

  it("does not mark the update processed when the handler throws", async () => {
    vi.mocked(handleMessage).mockRejectedValue(new Error("boom"));

    await dispatchUpdate(textUpdate(4, "سلام"));
    await flush();

    expect(markUpdateProcessed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("sends documents to the upload handler", async () => {
    const document = { file_id: "f1", file_name: "a.pdf" };

    await dispatchUpdate({
      update_id: 5,
      message: { chat: { id: 9 }, document },
    });
    await flush();

    expect(handleDocument).toHaveBeenCalledWith(9, document);
    expect(markUpdateProcessed).toHaveBeenCalledWith(5);
  });

  it("handles a 👍/👎 press and marks it processed", async () => {
    const { handleFeedback } = await import("../src/bot/feedback.js");
    const query = { id: "cb", data: "fb:1:1", message: { message_id: 3, chat: { id: 7 } } };

    await dispatchUpdate({ update_id: 12, callback_query: query });

    expect(handleFeedback).toHaveBeenCalledWith(query);
    expect(markUpdateProcessed).toHaveBeenCalledWith(12);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("sends photos to the photo handler", async () => {
    const photo = [{ file_id: "p1", width: 905, height: 1280 }];

    await dispatchUpdate({ update_id: 13, message: { chat: { id: 9 }, photo } });
    await flush();

    expect(handlePhoto).toHaveBeenCalledWith(9, photo);
    expect(markUpdateProcessed).toHaveBeenCalledWith(13);
  });

  it.each(["sticker", "voice", "video", "location"])("answers a %s with what the bot can read", async (field) => {
    await dispatchUpdate({ update_id: 14, message: { chat: { id: 7 }, [field]: {} } });

    expect(sendMessage).toHaveBeenCalledWith(7, UNSUPPORTED_MESSAGE_TEXT);
    expect(markUpdateProcessed).toHaveBeenCalledWith(14);
  });

  it("acknowledges updates with nothing to answer (edits, service messages) silently", async () => {
    await dispatchUpdate({ update_id: 6, message: { chat: { id: 7 } } });

    expect(markUpdateProcessed).toHaveBeenCalledWith(6);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("/cancel without a running request says there is nothing to cancel", async () => {
    await dispatchUpdate(textUpdate(7, "/cancel", 70));

    expect(sendMessage).toHaveBeenCalledWith(70, NO_REQUEST_TO_CANCEL_TEXT);
    expect(markUpdateProcessed).toHaveBeenCalledWith(7);
  });

  it("/cancel aborts the running request of the same chat", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(handleMessage).mockImplementation(async (_chatId, _text, s) => {
      signal = s;
      // Stays "busy" until it is cancelled.
      await new Promise((resolve) => s?.addEventListener("abort", resolve));
      return true;
    });

    await dispatchUpdate(textUpdate(8, "یک سؤال طولانی", 80));
    await dispatchUpdate(textUpdate(9, "/cancel", 80));
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(80, REQUEST_CANCELLED_TEXT);
  });

  it("a new message from the same chat cancels the previous one", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(handleMessage).mockImplementation(async (_chatId, _text, s) => {
      signals.push(s!);
      // Busy until cancelled, so the second message arrives while it runs.
      await new Promise((resolve) => s?.addEventListener("abort", resolve));
      return true;
    });

    await dispatchUpdate(textUpdate(10, "اول", 90));
    await dispatchUpdate(textUpdate(11, "دوم", 90));

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
