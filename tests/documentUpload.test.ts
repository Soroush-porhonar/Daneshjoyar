import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn(), downloadBaleDocument: vi.fn() }));
vi.mock("../src/db/users.js", () => ({ findOrCreateUser: vi.fn() }));
vi.mock("../src/db/documents.js", () => ({ findDuplicateDocument: vi.fn() }));
vi.mock("../src/rag/ingest.js", () => ({ ingestPdf: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: vi.fn(async () => ({ size: 4321 })),
  unlink: vi.fn(async () => {}),
}));

const { handleDocument } = await import("../src/chat/documentUpload.js");
const { sendMessage, downloadBaleDocument } = await import("../src/bale.js");
const { findOrCreateUser } = await import("../src/db/users.js");
const { findDuplicateDocument } = await import("../src/db/documents.js");
const { ingestPdf } = await import("../src/rag/ingest.js");
const { unlink } = await import("node:fs/promises");
const { DuplicateDocumentError } = await import("../src/errors.js");
const messages = await import("../src/messages.js");

const CHAT = 42;
const pdf = (size?: number) => ({
  file_id: "f1",
  file_name: "notes.pdf",
  mime_type: "application/pdf",
  ...(size === undefined ? {} : { file_size: size }),
});
const texts = () => vi.mocked(sendMessage).mock.calls.map((call) => call[1]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOrCreateUser).mockResolvedValue({ id: 3 } as never);
  vi.mocked(findDuplicateDocument).mockResolvedValue(null);
  vi.mocked(downloadBaleDocument).mockResolvedValue({ filePath: "/tmp/1-notes.pdf", filename: "notes.pdf" });
  vi.mocked(ingestPdf).mockResolvedValue({ documentId: 9, pageCount: 3, ocrPages: 0 });
});

describe("handleDocument: duplicate uploads", () => {
  it("refuses a file the user already has (same name and size) without downloading it", async () => {
    vi.mocked(findDuplicateDocument).mockResolvedValue({ id: 5, status: "completed" });

    await expect(handleDocument(CHAT, pdf(1234))).resolves.toBe(true);

    expect(findDuplicateDocument).toHaveBeenCalledWith(3, "notes.pdf", 1234);
    expect(downloadBaleDocument).not.toHaveBeenCalled();
    expect(ingestPdf).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(CHAT, messages.duplicateDocumentText("notes.pdf", false), {
      inline: [[expect.objectContaining({ callback_data: "docs" })]],
    });
  });

  it("says when the earlier copy is still being processed", async () => {
    vi.mocked(findDuplicateDocument).mockResolvedValue({ id: 5, status: "processing" });

    await handleDocument(CHAT, pdf(1234));

    expect(texts()).toEqual([messages.duplicateDocumentText("notes.pdf", true)]);
  });

  it("uploads a new file normally and records its size", async () => {
    await handleDocument(CHAT, pdf(1234));

    expect(ingestPdf).toHaveBeenCalledWith(3, "notes.pdf", "/tmp/1-notes.pdf", expect.any(Function), 1234);
    expect(texts().at(-1)).toBe(messages.fileProcessedText(0));
  });

  it("without a size from Bale, checks after downloading and deletes the duplicate copy", async () => {
    vi.mocked(findDuplicateDocument).mockResolvedValue({ id: 5, status: "completed" });

    await handleDocument(CHAT, pdf());

    expect(findDuplicateDocument).toHaveBeenCalledWith(3, "notes.pdf", 4321);
    expect(unlink).toHaveBeenCalledWith("/tmp/1-notes.pdf");
    expect(ingestPdf).not.toHaveBeenCalled();
    expect(texts().at(-1)).toBe(messages.duplicateDocumentText("notes.pdf", false));
  });

  it("the same file sent twice in quick succession: the database rule catches the second", async () => {
    vi.mocked(ingestPdf).mockRejectedValue(new DuplicateDocumentError("dup"));

    await expect(handleDocument(CHAT, pdf(1234))).resolves.toBe(true);

    expect(unlink).toHaveBeenCalledWith("/tmp/1-notes.pdf");
    expect(texts().at(-1)).toBe(messages.duplicateDocumentText("notes.pdf", true));
  });
});
