import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaleUpdate } from "../src/bale.js";

// Replace everything the dispatcher talks to (DB, Bale, handlers) with fakes.
vi.mock("../src/db/updates.js", () => ({
  receiveUpdate: vi.fn(),
  finishUpdate: vi.fn(),
}));
vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../src/chat/chatService.js", () => ({ handleMessage: vi.fn() }));
vi.mock("../src/chat/documentUpload.js", () => ({ handleDocument: vi.fn(), handlePhoto: vi.fn() }));
vi.mock("../src/bot/feedback.js", () => ({ handleFeedback: vi.fn() }));

const { dispatchUpdate, runningUpdates } = await import("../src/bot/dispatcher.js");
const { receiveUpdate, finishUpdate } = await import("../src/db/updates.js");
const { abortAllForShutdown } = await import("../src/bot/cancellation.js");
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
  vi.mocked(receiveUpdate).mockResolvedValue(true);
  vi.mocked(finishUpdate).mockResolvedValue(undefined);
  vi.mocked(handleMessage).mockResolvedValue(true);
  vi.mocked(handleDocument).mockResolvedValue(true);
  vi.mocked(handlePhoto).mockResolvedValue(true);
});

describe("dispatchUpdate", () => {
  it("skips an update seen before (its retries belong to the sweeper)", async () => {
    vi.mocked(receiveUpdate).mockResolvedValue(false);

    await dispatchUpdate(textUpdate(1, "سلام"));
    await flush();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(finishUpdate).not.toHaveBeenCalled();
  });

  it("records the update in the inbox before the work starts", async () => {
    vi.mocked(handleMessage).mockImplementation(async () => {
      expect(receiveUpdate).toHaveBeenCalled();
      return true;
    });

    await dispatchUpdate(textUpdate(15, "سلام"));
    await flush();

    expect(receiveUpdate).toHaveBeenCalledWith(textUpdate(15, "سلام"));
  });

  it("lets the poller retry when the update cannot be recorded", async () => {
    vi.mocked(receiveUpdate).mockRejectedValue(new Error("db down"));

    await expect(dispatchUpdate(textUpdate(16, "سلام"))).rejects.toThrow("db down");
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("handles a text message and marks it done on success", async () => {
    await dispatchUpdate(textUpdate(2, "  سلام  "));
    await flush();

    expect(handleMessage).toHaveBeenCalledWith(7, "سلام", expect.any(AbortSignal));
    expect(finishUpdate).toHaveBeenCalledWith(2, true);
    expect(runningUpdates()).toEqual([]);
  });

  it("marks the update failed when the handler reports failure", async () => {
    vi.mocked(handleMessage).mockResolvedValue(false);

    await dispatchUpdate(textUpdate(3, "سلام"));
    await flush();

    expect(finishUpdate).toHaveBeenCalledWith(3, false);
  });

  it("marks the update failed when the handler throws", async () => {
    vi.mocked(handleMessage).mockRejectedValue(new Error("boom"));

    await dispatchUpdate(textUpdate(4, "سلام"));
    await flush();

    expect(finishUpdate).toHaveBeenCalledWith(4, false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("reports the update as running while its work runs", async () => {
    let release!: () => void;
    vi.mocked(handleMessage).mockImplementation(() => new Promise((resolve) => (release = () => resolve(true))));

    await dispatchUpdate(textUpdate(17, "سلام", 170));
    expect(runningUpdates()).toEqual([17]);

    release();
    await flush();
    expect(runningUpdates()).toEqual([]);
  });

  it("marks a button press failed when its handler throws, without stopping the poller", async () => {
    const { handleFeedback } = await import("../src/bot/feedback.js");
    vi.mocked(handleFeedback).mockRejectedValueOnce(new Error("db down"));
    const query = { id: "cb", data: "fb:1:1", message: { message_id: 3, chat: { id: 7 } } };

    await expect(dispatchUpdate({ update_id: 18, callback_query: query })).resolves.toBeUndefined();
    expect(finishUpdate).toHaveBeenCalledWith(18, false);
  });

  it("sends documents to the upload handler", async () => {
    const document = { file_id: "f1", file_name: "a.pdf" };

    await dispatchUpdate({
      update_id: 5,
      message: { chat: { id: 9 }, document },
    });
    await flush();

    expect(handleDocument).toHaveBeenCalledWith(9, document);
    expect(finishUpdate).toHaveBeenCalledWith(5, true);
  });

  it("handles a 👍/👎 press and marks it processed", async () => {
    const { handleFeedback } = await import("../src/bot/feedback.js");
    const query = { id: "cb", data: "fb:1:1", message: { message_id: 3, chat: { id: 7 } } };

    await dispatchUpdate({ update_id: 12, callback_query: query });

    expect(handleFeedback).toHaveBeenCalledWith(query);
    expect(finishUpdate).toHaveBeenCalledWith(12, true);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("sends photos to the photo handler", async () => {
    const photo = [{ file_id: "p1", width: 905, height: 1280 }];

    await dispatchUpdate({ update_id: 13, message: { chat: { id: 9 }, photo } });
    await flush();

    expect(handlePhoto).toHaveBeenCalledWith(9, photo);
    expect(finishUpdate).toHaveBeenCalledWith(13, true);
  });

  it.each(["sticker", "voice", "video", "location"])("answers a %s with what the bot can read", async (field) => {
    await dispatchUpdate({ update_id: 14, message: { chat: { id: 7 }, [field]: {} } });

    expect(sendMessage).toHaveBeenCalledWith(7, UNSUPPORTED_MESSAGE_TEXT);
    expect(finishUpdate).toHaveBeenCalledWith(14, true);
  });

  it("acknowledges updates with nothing to answer (edits, service messages) silently", async () => {
    await dispatchUpdate({ update_id: 6, message: { chat: { id: 7 } } });

    expect(finishUpdate).toHaveBeenCalledWith(6, true);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("/cancel without a running request says there is nothing to cancel", async () => {
    await dispatchUpdate(textUpdate(7, "/cancel", 70));

    expect(sendMessage).toHaveBeenCalledWith(70, NO_REQUEST_TO_CANCEL_TEXT);
    expect(finishUpdate).toHaveBeenCalledWith(7, true);
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

  it("leaves work cut off by a shutdown unfinished, for the retry after the restart", async () => {
    vi.mocked(handleMessage).mockImplementation(async (_chatId, _text, s) => {
      await new Promise((resolve) => s?.addEventListener("abort", resolve));
      return true;
    });

    await dispatchUpdate(textUpdate(19, "سؤال", 190));
    abortAllForShutdown();
    await flush();

    expect(finishUpdate).not.toHaveBeenCalled();
  });
});
