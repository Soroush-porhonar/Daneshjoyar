import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../src/db/documents.js", () => ({ failInterruptedDocuments: vi.fn() }));

const { recoverInterruptedUploads } = await import("../src/bot/recovery.js");
const { sendMessage } = await import("../src/bale.js");
const { failInterruptedDocuments } = await import("../src/db/documents.js");
const { logger } = await import("../src/logger.js");
const messages = await import("../src/messages.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

describe("recoverInterruptedUploads", () => {
  it("asks each user to send their interrupted file again", async () => {
    vi.mocked(failInterruptedDocuments).mockResolvedValue([
      { chatId: "42", filename: "a.pdf" },
      { chatId: "7", filename: "b.pdf" },
    ]);

    await recoverInterruptedUploads();

    expect(sendMessage).toHaveBeenCalledWith(42, messages.uploadInterruptedText("a.pdf"));
    expect(sendMessage).toHaveBeenCalledWith(7, messages.uploadInterruptedText("b.pdf"));
  });

  it("keeps notifying the others when one message fails", async () => {
    vi.mocked(failInterruptedDocuments).mockResolvedValue([
      { chatId: "42", filename: "a.pdf" },
      { chatId: "7", filename: "b.pdf" },
    ]);
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("bale down"));

    await recoverInterruptedUploads();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it("never stops the bot from starting when the database is down", async () => {
    vi.mocked(failInterruptedDocuments).mockRejectedValue(new Error("db down"));

    await expect(recoverInterruptedUploads()).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
