import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn(async () => 500), editMessageText: vi.fn(async () => {}) }));

const { askConfirmation, answerConfirmation } = await import("../src/chat/confirmations.js");
const { sendMessage, editMessageText } = await import("../src/bale.js");
const { config } = await import("../src/config.js");
const { logger } = await import("../src/logger.js");

/** The token in the ✅ button of the last question asked. */
const lastToken = () =>
  (vi.mocked(sendMessage).mock.calls.at(-1)![2] as { inline: { callback_data: string }[][] }).inline[0]![0]!
    .callback_data.split(":")[1]!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(logger, "info").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("confirmations", () => {
  it("resolves with the student's answer", async () => {
    const answer = askConfirmation(42, "ادامه بدم؟");
    await vi.advanceTimersByTimeAsync(0);

    expect(answerConfirmation(lastToken(), 42, true)).toBe(true);
    await expect(answer).resolves.toBe(true);
  });

  it("ignores a press from another chat, and a second press", async () => {
    const answer = askConfirmation(42, "ادامه بدم؟");
    await vi.advanceTimersByTimeAsync(0);
    const token = lastToken();

    expect(answerConfirmation(token, 7, true)).toBe(false);
    expect(answerConfirmation(token, 42, false)).toBe(true);
    expect(answerConfirmation(token, 42, true)).toBe(false);
    await expect(answer).resolves.toBe(false);
  });

  it("takes no answer within the time limit as no, and drops the buttons", async () => {
    const answer = askConfirmation(42, "ادامه بدم؟");
    await vi.advanceTimersByTimeAsync(0);
    const token = lastToken();

    await vi.advanceTimersByTimeAsync(config.limits.confirmTimeoutMs);

    await expect(answer).resolves.toBe(false);
    expect(editMessageText).toHaveBeenCalledWith(42, 500, "ادامه بدم؟");
    expect(answerConfirmation(token, 42, true)).toBe(false);
  });
});
