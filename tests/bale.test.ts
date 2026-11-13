import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMessageText, keepTyping, sendMessage } from "../src/bale.js";

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
