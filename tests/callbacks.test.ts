import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({
  answerCallbackQuery: vi.fn(),
  editMessageText: vi.fn(),
  removeButtons: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("../src/db/users.js", () => ({ findOrCreateUser: vi.fn() }));
vi.mock("../src/db/documents.js", () => ({
  deleteDocument: vi.fn(),
  findDocumentFilename: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("../src/bot/feedback.js", () => ({ handleFeedback: vi.fn() }));

const { handleCallback } = await import("../src/bot/callbacks.js");
const { parseCallback } = await import("../src/bot/buttons.js");
const { answerCallbackQuery, editMessageText, removeButtons, sendMessage } = await import("../src/bale.js");
const { findOrCreateUser } = await import("../src/db/users.js");
const { deleteDocument, findDocumentFilename, listDocuments } = await import("../src/db/documents.js");
const { handleFeedback } = await import("../src/bot/feedback.js");
const { startRequest } = await import("../src/bot/cancellation.js");
const { clearPendingDeletion } = await import("../src/bot/pendingDelete.js");
const messages = await import("../src/messages.js");

const CHAT = 42;
const press = (data: string) => ({ id: "cb", data, message: { message_id: 7, chat: { id: CHAT } } });

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingDeletion(CHAT);
  vi.mocked(findOrCreateUser).mockResolvedValue({ id: 3 } as never);
  vi.mocked(listDocuments).mockResolvedValue([{ id: 5, filename: "notes.pdf", status: "completed" }]);
  vi.mocked(findDocumentFilename).mockResolvedValue("notes.pdf");
  vi.mocked(deleteDocument).mockResolvedValue({ filePath: null });
});

describe("parseCallback", () => {
  it.each([
    ["sel:5", null], // old lists still have select buttons; selection is gone
    ["del:12", { action: "delete", documentId: 12 }],
    ["delok", { action: "confirmDelete" }],
    ["delno", { action: "cancelDelete" }],
    ["docs", { action: "documents" }],
    ["cancel", { action: "cancel" }],
    ["info:7", { action: "info", documentId: 7 }],
    ["cf:0a1b2c3d:y", { action: "confirm", token: "0a1b2c3d", yes: true }],
    ["cf:0a1b2c3d:n", { action: "confirm", token: "0a1b2c3d", yes: false }],
    ["ocr:0a1b2c3d:n", { action: "confirm", token: "0a1b2c3d", yes: false }],
    ["ocr:xyz:y", null],
    ["sel:abc", null],
    ["toString", null],
    ["", null],
  ])("%s", (data, expected) => {
    expect(parseCallback(data)).toEqual(expected);
  });
});

describe("handleCallback", () => {
  it("says a ✅/❌ press came too late when its question is no longer waiting", async () => {
    await handleCallback(press("ocr:0a1b2c3d:y"));

    expect(answerCallbackQuery).toHaveBeenCalledWith("cb", messages.CONFIRMATION_EXPIRED_TEXT);
    expect(removeButtons).toHaveBeenCalledWith(CHAT, 7);
  });

  it("sends 👍/👎 presses to the feedback handler", async () => {
    await handleCallback(press("fb:9:1"));

    expect(handleFeedback).toHaveBeenCalled();
  });

  it("always acknowledges unknown buttons", async () => {
    await handleCallback(press("nonsense"));

    expect(answerCallbackQuery).toHaveBeenCalledWith("cb");
  });

  it("an old select button is acknowledged and does nothing", async () => {
    await handleCallback(press("sel:5"));

    expect(answerCallbackQuery).toHaveBeenCalledWith("cb");
    expect(editMessageText).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delete: asks for confirmation with yes/no buttons, deletes nothing yet", async () => {
    await handleCallback(press("del:5"));

    expect(sendMessage).toHaveBeenCalledWith(CHAT, messages.deleteConfirmationText("notes.pdf", 5), {
      inline: [[
        expect.objectContaining({ callback_data: "delok" }),
        expect.objectContaining({ callback_data: "delno" }),
      ]],
    });
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it("confirm: deletes and replaces the question with the result (no double press)", async () => {
    await handleCallback(press("del:5"));
    await handleCallback(press("delok"));

    expect(deleteDocument).toHaveBeenCalledWith(3, 5);
    expect(editMessageText).toHaveBeenLastCalledWith(CHAT, 7, messages.deleteSucceededText(5));
  });

  it("cancel delete: keeps the document", async () => {
    await handleCallback(press("del:5"));
    await handleCallback(press("delno"));

    expect(deleteDocument).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenLastCalledWith(CHAT, 7, messages.DELETE_CANCELLED_TEXT);
  });

  it("confirm without a pending delete says so", async () => {
    await handleCallback(press("delok"));

    expect(deleteDocument).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenLastCalledWith(CHAT, 7, messages.NO_PENDING_DELETE_TEXT);
  });

  it("⏹️ stops the running request and removes the button", async () => {
    const controller = startRequest(CHAT);

    await handleCallback(press("cancel"));

    expect(controller.signal.aborted).toBe(true);
    expect(answerCallbackQuery).toHaveBeenCalledWith("cb", messages.REQUEST_CANCELLED_TEXT);
    expect(removeButtons).toHaveBeenCalledWith(CHAT, 7);
  });

  it("⏹️ with nothing running says so", async () => {
    await handleCallback(press("cancel"));

    expect(answerCallbackQuery).toHaveBeenCalledWith("cb", messages.NO_REQUEST_TO_CANCEL_TEXT);
  });

  it("📚 opens the documents list with its buttons", async () => {
    await handleCallback(press("docs"));

    expect(sendMessage).toHaveBeenCalledWith(CHAT, messages.DOCUMENTS_LIST_TEXT, {
      inline: [
        [expect.objectContaining({ callback_data: "info:5" })],
        [expect.objectContaining({ callback_data: "del:5" })],
      ],
    });
  });

  it("tapping a name shows its full name and status", async () => {
    await handleCallback(press("info:5"));

    expect(listDocuments).toHaveBeenCalledWith(3);
    expect(answerCallbackQuery).toHaveBeenCalledWith(
      "cb",
      messages.documentInfoText("notes.pdf", "completed"),
    );
  });

  it("tapping a name of a document the user doesn't own shows nothing about it", async () => {
    await handleCallback(press("info:99"));

    expect(answerCallbackQuery).toHaveBeenCalledWith("cb", messages.DELETE_NOT_FOUND_TEXT);
  });

  it("a failed message update does not fail the press", async () => {
    vi.mocked(editMessageText).mockRejectedValue(new Error("message too old"));

    await expect(handleCallback(press("sel:5"))).resolves.toBeUndefined();
  });
});
