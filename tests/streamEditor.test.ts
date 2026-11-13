import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", async (importOriginal) => ({
  splitMessage: (await importOriginal<typeof import("../src/bale.js")>()).splitMessage,
  editMessageText: vi.fn(),
  sendMessage: vi.fn(),
}));

const { createLiveAnswer, liveText } = await import("../src/chat/streamEditor.js");
const { editMessageText, sendMessage } = await import("../src/bale.js");
const { BaleApiError } = await import("../src/errors.js");
const { config } = await import("../src/config.js");
const { logger } = await import("../src/logger.js");

const CHAT = 42;
const NOTICE = 900;
const cancel = [[{ text: "⏹️", callback_data: "cancel" }]];
const feedback = [[{ text: "👍", callback_data: "fb:1:1" }]];
const words = (n: number) => "کلمه ".repeat(n).trim();

/** Lets the editor's timers and pending Bale calls run. */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const edits = () => vi.mocked(editMessageText).mock.calls;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(editMessageText).mockResolvedValue(undefined);
  vi.mocked(sendMessage).mockResolvedValue(901);
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => vi.useRealTimers());

describe("liveText", () => {
  it("hides a citation that is still being written", () => {
    expect(liveText("نکته اول [1]. نکته دوم [2، ")).toBe("نکته اول [1]. نکته دوم");
    expect(liveText("نکته [")).toBe("نکته");
  });

  it("keeps finished citations", () => {
    expect(liveText("نکته [1]")).toBe("نکته [1]");
  });
});

describe("createLiveAnswer, edit mode", () => {
  const live = () => createLiveAnswer(CHAT, NOTICE, { mode: "edit", liveButtons: cancel });

  it("edits the notice with the text so far, with the cancel button", async () => {
    const answer = live();
    answer.update(words(20));
    await advance(0);

    expect(edits()).toEqual([[CHAT, NOTICE, words(20), cancel]]);
    expect(answer.started).toBe(true);
  });

  it("edits at most once per interval and sends the newest text", async () => {
    const answer = live();
    answer.update(words(20));
    await advance(0);
    answer.update(words(40));
    answer.update(words(60));
    await advance(config.stream.editIntervalMs - 1);
    expect(edits()).toHaveLength(1);

    await advance(1);
    expect(edits()).toHaveLength(2);
    expect(edits()[1]![2]).toBe(words(60));
  });

  it("waits for enough new text before editing again", async () => {
    const answer = live();
    answer.update(words(20));
    await advance(0);
    answer.update(`${words(20)} یک`);
    await advance(config.stream.editIntervalMs * 3);

    expect(edits()).toHaveLength(1);
  });

  it("on a rate limit waits retry_after and doubles the interval", async () => {
    vi.mocked(editMessageText).mockRejectedValueOnce(new BaleApiError("Too Many Requests", 429, 4));
    const answer = live();
    answer.update(words(20));
    await advance(0);
    answer.update(words(40));
    await advance(3_999);
    expect(edits()).toHaveLength(1);

    await advance(1);
    expect(edits()).toHaveLength(2);

    // Next edit only after the doubled interval.
    answer.update(words(60));
    await advance(config.stream.editIntervalMs * 2 - 1);
    expect(edits()).toHaveLength(2);
    await advance(1);
    expect(edits()).toHaveLength(3);
    expect(logger.warn).toHaveBeenCalledWith("[Stream] Bale rate limit", expect.anything());
  });

  it("continues in a new message past the length limit and moves the button", async () => {
    const answer = live();
    const long = `${"الف ".repeat(800)}\n${"ب ".repeat(1000)}`; // over 4000 characters
    answer.update(long);
    await advance(0);

    expect(edits()[0]![1]).toBe(NOTICE);
    expect(edits()[0]![3]).toBeUndefined(); // the first part loses the button
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.any(String), { inline: cancel });
    expect(answer.messageIds).toEqual([NOTICE, 901]);
  });

  it("finish puts the final text and buttons in place and stops live edits", async () => {
    const answer = live();
    answer.update(words(20));
    await advance(0);
    answer.update(words(40));

    await expect(answer.finish("جواب نهایی", feedback)).resolves.toBe(true);
    await advance(config.stream.editIntervalMs * 2);

    expect(edits().at(-1)).toEqual([CHAT, NOTICE, "جواب نهایی", feedback]);
    expect(edits()).toHaveLength(2);
  });

  it("finish reports a refusal so the caller can send the answer anew", async () => {
    vi.mocked(editMessageText).mockRejectedValue(new Error("message to edit not found"));

    await expect(live().finish("جواب", feedback)).resolves.toBe(false);
  });

  it("finish retries once after a rate limit", async () => {
    vi.mocked(editMessageText).mockRejectedValueOnce(new BaleApiError("Too Many Requests", 429, 2));
    const done = live().finish("جواب", feedback);
    await advance(2_000);

    await expect(done).resolves.toBe(true);
    expect(edits()).toHaveLength(2);
  });

  it("ignores Bale's 'message is not modified'", async () => {
    vi.mocked(editMessageText).mockRejectedValueOnce(new Error("Bad Request: message is not modified"));

    await expect(live().finish("جواب", feedback)).resolves.toBe(true);
  });

  it("stop ends live edits", async () => {
    const answer = live();
    answer.update(words(20));
    await answer.stop();
    await advance(config.stream.editIntervalMs * 2);

    expect(edits()).toHaveLength(0);
  });
});

describe("createLiveAnswer, parts mode", () => {
  const live = () => createLiveAnswer(CHAT, NOTICE, { mode: "parts", liveButtons: cancel });
  const paragraph = (n: number) => `${"کلمه ".repeat(n).trim()}.`;

  it("shows nothing until a paragraph long enough has ended", async () => {
    const answer = live();
    answer.update(paragraph(50));
    await advance(config.stream.editIntervalMs * 2);

    expect(edits()).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends finished paragraphs once and the rest with the buttons at the end", async () => {
    const first = paragraph(150); // over minPartChars
    const answer = live();
    answer.update(`${first}\n\nادامه`);
    await advance(0);
    expect(edits()).toEqual([[CHAT, NOTICE, first, cancel]]);

    answer.update(`${first}\n\nادامه‌ی جواب`);
    await advance(config.stream.editIntervalMs * 2);
    expect(edits()).toHaveLength(1); // the part already sent is not edited

    await answer.finish(`${first}\n\nادامه‌ی جواب کامل`, feedback);

    expect(edits()).toHaveLength(2); // the button leaves the first part
    expect(edits()[1]).toEqual([CHAT, NOTICE, first, undefined]);
    expect(sendMessage).toHaveBeenCalledWith(CHAT, "ادامه‌ی جواب کامل", { inline: feedback });
  });

  it("sends at most maxParts messages", async () => {
    const answer = live();
    let text = "";
    for (let part = 0; part < config.stream.maxParts + 2; part++) {
      text += `${paragraph(150)}\n\n`;
      answer.update(`${text}ادامه`);
      await advance(config.stream.editIntervalMs * 2);
    }

    // Live parts leave the last part for the final answer.
    expect(answer.messageIds).toHaveLength(config.stream.maxParts - 1);
    expect(sendMessage).toHaveBeenCalledTimes(config.stream.maxParts - 2);
  });
});
