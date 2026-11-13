import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/chat/confirmations.js", () => ({ askConfirmation: vi.fn() }));
vi.mock("../src/db/documents.js", () => ({ deleteUserData: vi.fn() }));
vi.mock("../src/files.js", () => ({ removeUploadedFile: vi.fn() }));

const { deleteMyDataCommand } = await import("../src/bot/commands/privacy.js");
const { askConfirmation } = await import("../src/chat/confirmations.js");
const { deleteUserData } = await import("../src/db/documents.js");
const { removeUploadedFile } = await import("../src/files.js");
const { logger } = await import("../src/logger.js");
const messages = await import("../src/messages.js");

const context = { chatId: 42, userId: 3, args: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "info").mockImplementation(() => {});
});

describe("/deletemydata", () => {
  it("deletes nothing without a yes", async () => {
    vi.mocked(askConfirmation).mockResolvedValue(false);

    expect(await deleteMyDataCommand(context)).toBe(messages.MY_DATA_KEPT_TEXT);
    expect(deleteUserData).not.toHaveBeenCalled();
  });

  it("asks with its own buttons", async () => {
    vi.mocked(askConfirmation).mockResolvedValue(false);

    await deleteMyDataCommand(context);

    expect(askConfirmation).toHaveBeenCalledWith(42, messages.DELETE_MY_DATA_QUESTION, {
      yes: messages.DELETE_MY_DATA_YES_BUTTON,
      no: messages.DELETE_MY_DATA_NO_BUTTON,
      timeoutMs: expect.any(Number),
    });
  });

  it("after a yes deletes the rows and the files, and asks not to save the reply", async () => {
    vi.mocked(askConfirmation).mockResolvedValue(true);
    vi.mocked(deleteUserData).mockResolvedValue(["uploads/1-a.pdf", "uploads/2-b.pdf"]);

    expect(await deleteMyDataCommand(context)).toEqual({ text: messages.MY_DATA_DELETED_TEXT, forgotUser: true });
    expect(deleteUserData).toHaveBeenCalledWith(3, 42);
    expect(removeUploadedFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(removeUploadedFile).mock.calls.map(([file]) => file)).toEqual(["uploads/1-a.pdf", "uploads/2-b.pdf"]);
  });
});
