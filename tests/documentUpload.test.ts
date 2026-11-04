import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/bale.js", () => ({ sendMessage: vi.fn(), downloadBaleDocument: vi.fn() }));
vi.mock("../src/db/users.js", () => ({ findOrCreateUser: vi.fn() }));
vi.mock("../src/db/documents.js", () => ({ findDuplicateDocument: vi.fn() }));
// The real file-kind check, a fake ingestion.
vi.mock("../src/rag/ingest.js", async (importOriginal) => ({
  documentKind: (await importOriginal<typeof import("../src/rag/ingest.js")>()).documentKind,
  ingestDocument: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: vi.fn(async () => ({ size: 4321 })),
  unlink: vi.fn(async () => {}),
}));

const { handleDocument, handlePhoto, photoFilename } = await import("../src/chat/documentUpload.js");
const { sendMessage, downloadBaleDocument } = await import("../src/bale.js");
const { findOrCreateUser } = await import("../src/db/users.js");
const { findDuplicateDocument } = await import("../src/db/documents.js");
const { documentKind, ingestDocument } = await import("../src/rag/ingest.js");
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
  vi.mocked(ingestDocument).mockResolvedValue({ documentId: 9, pageCount: 3, ocrPages: 0 });
});

describe("handleDocument: duplicate uploads", () => {
  it("refuses a file the user already has (same name and size) without downloading it", async () => {
    vi.mocked(findDuplicateDocument).mockResolvedValue({ id: 5, status: "completed" });

    await expect(handleDocument(CHAT, pdf(1234))).resolves.toBe(true);

    expect(findDuplicateDocument).toHaveBeenCalledWith(3, "notes.pdf", 1234);
    expect(downloadBaleDocument).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
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

    expect(ingestDocument).toHaveBeenCalledWith(
      3,
      "notes.pdf",
      "/tmp/1-notes.pdf",
      expect.any(Function),
      1234,
      "pdf",
    );
    expect(texts().at(-1)).toBe(messages.fileProcessedText(0));
  });

  it("without a size from Bale, checks after downloading and deletes the duplicate copy", async () => {
    vi.mocked(findDuplicateDocument).mockResolvedValue({ id: 5, status: "completed" });

    await handleDocument(CHAT, pdf());

    expect(findDuplicateDocument).toHaveBeenCalledWith(3, "notes.pdf", 4321);
    expect(unlink).toHaveBeenCalledWith("/tmp/1-notes.pdf");
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(texts().at(-1)).toBe(messages.duplicateDocumentText("notes.pdf", false));
  });

  it("the same file sent twice in quick succession: the database rule catches the second", async () => {
    vi.mocked(ingestDocument).mockRejectedValue(new DuplicateDocumentError("dup"));

    await expect(handleDocument(CHAT, pdf(1234))).resolves.toBe(true);

    expect(unlink).toHaveBeenCalledWith("/tmp/1-notes.pdf");
    expect(texts().at(-1)).toBe(messages.duplicateDocumentText("notes.pdf", true));
  });
});

describe("documentKind", () => {
  it.each([
    ["notes.pdf", undefined, "pdf"],
    ["NOTES.PDF", undefined, "pdf"],
    ["notes", "application/pdf", "pdf"],
    ["page.jpg", undefined, "image"],
    ["page.JPEG", undefined, "image"],
    ["page.png", undefined, "image"],
    ["page.webp", undefined, "image"],
    [undefined, "image/jpeg", "image"],
    ["page.heic", "image/heic", null],
    ["notes.docx", undefined, null],
    [undefined, undefined, null],
  ])("name %s, type %s: %s", (filename, mimeType, kind) => {
    expect(documentKind(filename, mimeType)).toBe(kind);
  });
});

describe("handleDocument: other files", () => {
  it("says which files it reads when a file is neither a PDF nor an image", async () => {
    await expect(handleDocument(CHAT, { file_id: "f", file_name: "notes.docx" })).resolves.toBe(true);

    expect(texts()).toEqual([messages.UNSUPPORTED_FILE_TEXT]);
    expect(downloadBaleDocument).not.toHaveBeenCalled();
  });

  it("reads an image file as a photo: no page-count progress, and no 'read by OCR' note", async () => {
    vi.mocked(downloadBaleDocument).mockResolvedValue({ filePath: "/tmp/1-page.jpg", filename: "page.jpg" });
    vi.mocked(ingestDocument).mockResolvedValue({ documentId: 9, pageCount: 1, ocrPages: 1 });

    await handleDocument(CHAT, { file_id: "f", file_name: "page.jpg", mime_type: "image/jpeg", file_size: 900 });

    expect(ingestDocument).toHaveBeenCalledWith(3, "page.jpg", "/tmp/1-page.jpg", undefined, 900, "image");
    expect(texts()).toEqual([messages.PHOTO_RECEIVED_TEXT, messages.fileProcessedText(0)]);
  });

  it("names an image file that has no name as an image, not a PDF", async () => {
    await handleDocument(CHAT, { file_id: "f", mime_type: "image/png", file_size: 900 });

    expect(downloadBaleDocument).toHaveBeenCalledWith(expect.objectContaining({ file_name: "photo.jpg" }));
  });
});

describe("handlePhoto", () => {
  const sizes = [
    { file_id: "small", width: 90, height: 128, file_size: 3000 },
    { file_id: "large", width: 905, height: 1280, file_size: 150_000 },
    { file_id: "medium", width: 320, height: 452, file_size: 20_000 },
  ];

  it("reads the largest size, named by the time it was sent", async () => {
    const now = new Date("2026-11-04T12:00:05Z");

    await handlePhoto(CHAT, sizes, now);

    expect(downloadBaleDocument).toHaveBeenCalledWith({
      file_id: "large",
      file_name: "photo-2026-11-04-15-30-05.jpg",
      mime_type: "image/jpeg",
      file_size: 150_000,
    });
    expect(ingestDocument).toHaveBeenCalledWith(
      3,
      expect.any(String),
      expect.any(String),
      undefined,
      150_000,
      "image",
    );
  });

  it("the same photo sent twice in the same second is caught as a duplicate", async () => {
    vi.mocked(findDuplicateDocument).mockResolvedValue({ id: 5, status: "completed" });

    await handlePhoto(CHAT, sizes, new Date("2026-11-04T12:00:05Z"));

    expect(findDuplicateDocument).toHaveBeenCalledWith(3, "photo-2026-11-04-15-30-05.jpg", 150_000);
    expect(downloadBaleDocument).not.toHaveBeenCalled();
  });
});

describe("photoFilename", () => {
  it("uses Iran's time (UTC+3:30), in a 24-hour clock", () => {
    expect(photoFilename(new Date("2026-11-04T21:15:00Z"))).toBe("photo-2026-11-05-00-45-00.jpg");
  });
});
