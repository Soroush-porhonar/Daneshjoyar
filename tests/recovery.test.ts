import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../src/db/documents.js", () => ({ failInterruptedDocuments: vi.fn() }));

const { recoverInterruptedUploads } = await import("../src/bot/recovery.js");
const { sendMessage } = await import("../src/bale.js");
const { failInterruptedDocuments } = await import("../src/db/documents.js");
const { logger } = await import("../src/logger.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

describe("recoverInterruptedUploads", () => {
  it("marks interrupted uploads failed without messaging: the inbox retries them", async () => {
    vi.mocked(failInterruptedDocuments).mockResolvedValue([{ chatId: "42", filename: "a.pdf" }]);

    await recoverInterruptedUploads();

    expect(failInterruptedDocuments).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never stops the bot from starting when the database is down", async () => {
    vi.mocked(failInterruptedDocuments).mockRejectedValue(new Error("db down"));

    await expect(recoverInterruptedUploads()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
