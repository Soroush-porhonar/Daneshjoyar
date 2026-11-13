import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMessageText, getUpdates, keepTyping, sendMessage } from "../src/bale.js";
import { BaleApiError } from "../src/errors.js";
import { logger } from "../src/logger.js";

const fetchMock = vi.fn();
let nextId = 100;

beforeEach(() => {
  nextId = 100;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } })),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));

describe("sendMessage", () => {
  it("puts buttons only on the last part of a long message and returns its id", async () => {
    const long = `${"الف ".repeat(1200)}\n${"ب ".repeat(1200)}`;

    const id = await sendMessage(1, long, { inline: [[{ text: "👍", callback_data: "fb:1:1" }]] });

    const sent = bodies();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(0, -1).every((body) => body.reply_markup === undefined)).toBe(true);
    expect(sent.at(-1).reply_markup).toEqual({ inline_keyboard: [[{ text: "👍", callback_data: "fb:1:1" }]] });
    expect(id).toBe(100 + sent.length - 1);
  });

  it("sends a bottom keyboard as rows of text buttons", async () => {
    await sendMessage(1, "سلام", { keyboard: [["📚 جزوه‌های من"], ["❓ راهنما", "ℹ️ درباره"]] });

    expect(bodies()[0].reply_markup).toEqual({
      keyboard: [[{ text: "📚 جزوه‌های من" }], [{ text: "❓ راهنما" }, { text: "ℹ️ درباره" }]],
    });
  });

  it("sends no markup when none is given", async () => {
    await sendMessage(1, "سلام");

    expect(bodies()[0]).not.toHaveProperty("reply_markup");
  });
});

describe("editMessageText", () => {
  it("replaces the text and removes the buttons when none are given", async () => {
    await editMessageText(1, 9, "حذف شد");

    expect(fetchMock.mock.calls[0]![0]).toMatch(/editMessageText$/);
    expect(bodies()[0]).toEqual({
      chat_id: 1,
      message_id: 9,
      text: "حذف شد",
      reply_markup: { inline_keyboard: [] },
    });
  });
});

describe("keepTyping", () => {
  it("shows typing now and every 5 seconds until stopped", async () => {
    vi.useFakeTimers();
    try {
      const stop = keepTyping(7);
      await vi.advanceTimersByTimeAsync(11_000);
      stop();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("sendChatAction"))).toBe(true);
      expect(bodies()).toEqual([1, 2, 3].map(() => ({ chat_id: 7, action: "typing" })));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retries", () => {
  const ok = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  const failure = (status: number, extra: object = {}) =>
    new Response(JSON.stringify({ ok: false, error_code: status, description: "nope", ...extra }), { status });
  const networkError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("waits retry_after on a rate limit, then succeeds", async () => {
    fetchMock.mockResolvedValueOnce(failure(429, { parameters: { retry_after: 3 } })).mockResolvedValueOnce(ok());

    const sent = sendMessage(1, "سلام");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(sent).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repeats a server error with growing delays, then gives up", async () => {
    fetchMock.mockImplementation(async () => failure(502));

    const edit = editMessageText(1, 2, "متن").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7_000);

    expect(await edit).toBeInstanceOf(BaleApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // the call and three repeats (1, 2, 4 s)
  });

  it("does not repeat a client error", async () => {
    fetchMock.mockResolvedValueOnce(failure(400));

    await expect(editMessageText(1, 2, "متن")).rejects.toThrow("nope");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeats a message that never reached Bale", async () => {
    fetchMock.mockRejectedValueOnce(networkError("ECONNREFUSED")).mockResolvedValueOnce(ok());

    const sent = sendMessage(1, "سلام");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(sent).resolves.toBe(1);
  });

  it("does not repeat a message that timed out: it may have been delivered", async () => {
    fetchMock.mockRejectedValueOnce(timeout());

    await expect(sendMessage(1, "سلام")).rejects.toThrow("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeats an edit that timed out (editing twice is harmless)", async () => {
    fetchMock.mockRejectedValueOnce(timeout()).mockResolvedValueOnce(ok());

    const edit = editMessageText(1, 2, "متن");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(edit).resolves.toBeUndefined();
  });

  it("fails at once when asked not to retry", async () => {
    fetchMock.mockResolvedValueOnce(failure(429, { parameters: { retry_after: 3 } }));

    await expect(editMessageText(1, 2, "متن", undefined, { retry: false })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getUpdates", () => {
  it("long-polls with Bale's 25-second cap", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: [] })));

    await getUpdates(42);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("timeout")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("42");
  });
});
