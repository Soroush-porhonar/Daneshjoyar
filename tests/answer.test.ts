import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChunk, DocumentChunk } from "../src/rag/retrieve.js";

vi.mock("../src/db/conversations.js", () => ({ getSelectedDocumentId: vi.fn() }));
vi.mock("../src/rag/retrieve.js", () => ({
  retrieveContext: vi.fn(),
  getDocumentChunks: vi.fn(),
  rankedCandidates: vi.fn(),
}));
vi.mock("../src/llm/ollamaClient.js", () => ({ chat: vi.fn() }));

const { answerFromDocuments, prefetchCandidates } = await import("../src/rag/answer.js");
const { getSelectedDocumentId } = await import("../src/db/conversations.js");
const { getDocumentChunks, rankedCandidates, retrieveContext } = await import(
  "../src/rag/retrieve.js"
);
const { chat } = await import("../src/llm/ollamaClient.js");
const messages = await import("../src/messages.js");

const chunk = (chunkIndex: number, pageNumber: number, isHit = true): ContextChunk => ({
  documentId: 1,
  filename: "notes.pdf",
  pageNumber,
  chunkIndex,
  content: `متن صفحه ${pageNumber}`,
  isHit,
});

/** The user prompt of the n-th model call. */
const prompt = (call: number) => vi.mocked(chat).mock.calls[call]![0].messages[1]!.content;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSelectedDocumentId).mockResolvedValue(1);
  vi.mocked(chat).mockResolvedValue("پاسخ مدل");
});

describe("answerFromDocuments", () => {
  it("asks the user to pick a document first", async () => {
    vi.mocked(getSelectedDocumentId).mockResolvedValue(null);

    expect(await answerFromDocuments(8, "سؤال")).toBe(messages.NO_DOCUMENT_SELECTED_TEXT);
    expect(chat).not.toHaveBeenCalled();
  });

  it("does not call the model when nothing relevant was found", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([]);

    expect(await answerFromDocuments(8, "سؤال", "focused")).toBe(
      messages.NO_RELEVANT_CONTENT_TEXT,
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it("answers from the retrieved chunks and cites only the real hits", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 3, false), chunk(1, 4), chunk(2, 5, false)]);

    const answer = await answerFromDocuments(8, "سؤال من", "focused");

    expect(prompt(0)).toContain("سؤال من");
    expect(prompt(0)).toContain("متن صفحه 3"); // neighbours are context...
    expect(answer).toContain(messages.sourceLineText("notes.pdf", 4));
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 3)); // ...but not sources
    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال من", "focused", 1, undefined);
  });

  it("puts the student's question after the sources, so exercise questions in notes aren't answered instead", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([
      { ...chunk(0, 151), content: "خلاصه فصل\nتست پویا را کامل توضیح دهید ؟" },
    ]);

    await answerFromDocuments(8, "رسمی‌ترین نوع بازبینی کدام است؟", "focused");

    const text = prompt(0);
    expect(text.trim().endsWith("رسمی‌ترین نوع بازبینی کدام است؟")).toBe(true);
    expect(text.indexOf("تست پویا را کامل")).toBeLessThan(text.indexOf("رسمی‌ترین نوع بازبینی"));
  });

  it("uses results searched early for the same question instead of searching again", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 2)]);
    const ranked = [{ ...chunk(0, 2), distance: 0.2 }];
    const early = Promise.resolve({ question: "سؤال", documentId: 4, ranked });

    await answerFromDocuments(8, "سؤال", "focused", undefined, early);

    expect(getSelectedDocumentId).not.toHaveBeenCalled();
    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", 4, ranked);
  });

  it("searches again when the early results were for a different question", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 2)]);
    const early = Promise.resolve({ question: "سؤال دیگر", documentId: 4, ranked: [] });

    await answerFromDocuments(8, "سؤال", "focused", undefined, early);

    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", 1, undefined);
  });

  it("searches again when the early search failed", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 2)]);
    const failed = Promise.reject(new Error("db down"));
    failed.catch(() => {});

    await answerFromDocuments(8, "سؤال", "focused", undefined, failed);

    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", 1, undefined);
  });

  it("uses low temperature for factual answers", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 1)]);

    await answerFromDocuments(8, "سؤال", "multi_part");

    expect(vi.mocked(chat).mock.calls[0]![0].options?.temperature).toBe(0.2);
  });

  it("summarises big documents in batches, then combines them (map-reduce)", async () => {
    const long = "ا".repeat(4000);
    const chunks: DocumentChunk[] = [1, 2, 3, 4, 5].map((page) => ({
      documentId: 1,
      filename: "notes.pdf",
      pageNumber: page,
      chunkIndex: page - 1,
      content: long,
    }));
    vi.mocked(getDocumentChunks).mockResolvedValue(chunks);
    vi.mocked(chat).mockImplementation(async (request) =>
      request.messages[1]!.content.includes("خلاصه") ? "پاسخ نهایی" : "خلاصه یک بخش",
    );

    const answer = await answerFromDocuments(8, "فصل را خلاصه کن", "broad");

    // 5 × 4000 chars with a 9000-char budget -> 3 batches + 1 final call.
    expect(chat).toHaveBeenCalledTimes(4);
    expect(prompt(3)).toContain("خلاصه بخش 3");
    expect(answer.startsWith("پاسخ نهایی")).toBe(true);
    expect(answer).toContain(messages.sourceLineText("notes.pdf", 5));
  });

  it("cites only the pages the batch summaries drew on in broad mode", async () => {
    const chunks: DocumentChunk[] = [1, 2, 3].map((page) => ({
      documentId: 1,
      filename: "notes.pdf",
      pageNumber: page,
      chunkIndex: page - 1,
      content: `متن صفحه ${page}`,
    }));
    vi.mocked(getDocumentChunks).mockResolvedValue(chunks);
    vi.mocked(chat).mockResolvedValueOnce("تعریف پشته (صفحه PDF 2)").mockResolvedValueOnce("پاسخ نهایی");

    const answer = await answerFromDocuments(8, "فصل را خلاصه کن", "broad");

    expect(answer).toContain(messages.sourceLineText("notes.pdf", 2));
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 1));
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 3));
  });

  it("numbers the sources in the prompt and lists the ones the answer cites", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 3, false), chunk(1, 4), chunk(2, 5)]);
    vi.mocked(chat).mockResolvedValue("پشته LIFO است [3].");

    const answer = await answerFromDocuments(8, "سؤال", "focused");

    expect(prompt(0)).toContain("منبع 3 — فایل: notes.pdf، صفحه PDF 5");
    expect(answer).toContain(`- [3] ${messages.sourceLineText("notes.pdf", 5)}`);
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 4));
  });

  it("passes the cancel signal to the model", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 1)]);
    const controller = new AbortController();

    await answerFromDocuments(8, "سؤال", "focused", controller.signal);

    expect(vi.mocked(chat).mock.calls[0]![0].signal).toBe(controller.signal);
  });
});

describe("prefetchCandidates", () => {
  beforeEach(() => vi.mocked(rankedCandidates).mockResolvedValue([]));

  it("reranks the previous answer's hits with the results when they are from the selected document", async () => {
    await prefetchCandidates(8, "سؤال", { documentId: 1, chunkIndexes: [4, 5] });

    expect(rankedCandidates).toHaveBeenCalledWith(8, "سؤال", 1, [4, 5]);
  });

  it("ignores hits from another document", async () => {
    await prefetchCandidates(8, "سؤال", { documentId: 2, chunkIndexes: [4, 5] });

    expect(rankedCandidates).toHaveBeenCalledWith(8, "سؤال", 1, []);
  });
});
