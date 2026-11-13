import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChunk, DocumentChunk, RetrievedChunk } from "../src/rag/retrieve.js";

vi.mock("../src/db/documents.js", () => ({ listCompletedDocuments: vi.fn() }));
vi.mock("../src/db/enrichment.js", () => ({ getSectionSummaries: vi.fn() }));
vi.mock("../src/rag/retrieve.js", () => ({
  retrieveContext: vi.fn(),
  getDocumentChunks: vi.fn(),
  rankedCandidates: vi.fn(),
}));
vi.mock("../src/llm/ollamaClient.js", () => ({ chat: vi.fn() }));

const { answerFromDocuments, pickDocument, prefetchCandidates } = await import("../src/rag/answer.js");
const { listCompletedDocuments } = await import("../src/db/documents.js");
const { getSectionSummaries } = await import("../src/db/enrichment.js");
const { getDocumentChunks, rankedCandidates, retrieveContext } = await import(
  "../src/rag/retrieve.js"
);
const { chat } = await import("../src/llm/ollamaClient.js");
const messages = await import("../src/messages.js");

const chunk = (chunkIndex: number, pageNumber: number, isHit = true, documentId = 1): ContextChunk => ({
  documentId,
  filename: documentId === 1 ? "notes.pdf" : "other.pdf",
  pageNumber,
  chunkIndex,
  content: `متن صفحه ${pageNumber}`,
  isHit,
});

/** The user prompt of the n-th model call. */
const prompt = (call: number) => vi.mocked(chat).mock.calls[call]![0].messages[1]!.content;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCompletedDocuments).mockResolvedValue([{ id: 1, filename: "notes.pdf" }]);
  vi.mocked(rankedCandidates).mockResolvedValue([]);
  vi.mocked(getSectionSummaries).mockResolvedValue([]);
  vi.mocked(chat).mockResolvedValue("پاسخ مدل");
});

describe("answerFromDocuments", () => {
  it("does not call the model when nothing relevant was found", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([]);

    expect(await answerFromDocuments(8, "سؤال", "focused")).toBe(
      messages.NO_RELEVANT_CONTENT_TEXT,
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it("answers from the retrieved chunks of all documents and cites only the real hits", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 3, false), chunk(1, 4), chunk(2, 5, false)]);

    const answer = await answerFromDocuments(8, "سؤال من", "focused");

    expect(prompt(0)).toContain("سؤال من");
    expect(prompt(0)).toContain("متن صفحه 3"); // neighbours are context...
    expect(answer).toContain(messages.sourceLineText("notes.pdf", 4));
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 3)); // ...but not sources
    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال من", "focused", {});
  });

  it("records every document the answer's hits came from", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([
      chunk(1, 4),
      chunk(2, 5, false, 3), // a neighbour only: not a source
      chunk(7, 2, true, 2),
    ]);
    const trace = {};

    await answerFromDocuments(8, "سؤال", "focused", { trace });

    expect(trace).toMatchObject({ documentIds: [1, 2] });
  });

  it("can be pinned to one document (the evals compare versions)", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 2)]);

    await answerFromDocuments(8, "سؤال", "focused", { documentId: 4 });

    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", { documentId: 4 });
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
    const prefetch = Promise.resolve({ question: "سؤال", ranked });

    await answerFromDocuments(8, "سؤال", "focused", { prefetch });

    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", { ranked });
  });

  it("searches again when the early results were for a different question", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 2)]);
    const prefetch = Promise.resolve({ question: "سؤال دیگر", ranked: [] });

    await answerFromDocuments(8, "سؤال", "focused", { prefetch });

    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", {});
  });

  it("searches again when the early search failed", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 2)]);
    const prefetch = Promise.reject(new Error("db down"));
    prefetch.catch(() => {});

    await answerFromDocuments(8, "سؤال", "focused", { prefetch });

    expect(retrieveContext).toHaveBeenCalledWith(8, "سؤال", "focused", {});
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
    // The summary says which document it is about: the bot picked it.
    expect(answer.startsWith(`${messages.summaryHeaderText("notes.pdf")}\n\nپاسخ نهایی`)).toBe(true);
    expect(answer).toContain(messages.sourceLineText("notes.pdf", 5));
  });

  it("summarises an enriched document from its stored section summaries in one call", async () => {
    const chunks: DocumentChunk[] = [1, 2, 3].map((page) => ({
      documentId: 1,
      filename: "notes.pdf",
      pageNumber: page,
      chunkIndex: page - 1,
      content: `متن صفحه ${page}`,
    }));
    vi.mocked(getDocumentChunks).mockResolvedValue(chunks);
    vi.mocked(getSectionSummaries).mockResolvedValue([
      { sectionIndex: 0, pageStart: 1, pageEnd: 2, summary: "تعریف سیستم خبره (صفحه PDF 2)" },
      { sectionIndex: 1, pageStart: 3, pageEnd: 3, summary: "خصوصیات" },
    ]);
    vi.mocked(chat).mockResolvedValue("پاسخ نهایی");

    const answer = await answerFromDocuments(8, "خلاصه کن", "broad");

    expect(chat).toHaveBeenCalledTimes(1);
    expect(prompt(0)).toContain("تعریف سیستم خبره");
    expect(answer).toContain(messages.sourceLineText("notes.pdf", 2));
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 3));
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

  it("says there is nothing to summarise without documents", async () => {
    vi.mocked(listCompletedDocuments).mockResolvedValue([]);

    expect(await answerFromDocuments(8, "خلاصه کن", "broad")).toBe(messages.NO_DOCUMENT_CONTENT_TEXT);
    expect(chat).not.toHaveBeenCalled();
  });

  it("numbers the sources in the prompt and lists the ones the answer cites", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 3, false), chunk(1, 4), chunk(2, 5)]);
    vi.mocked(chat).mockResolvedValue("پشته LIFO است [3].");

    const answer = await answerFromDocuments(8, "سؤال", "focused");

    expect(prompt(0)).toContain("منبع 3 — فایل: notes.pdf، صفحه PDF 5");
    // Shown renumbered from 1: the student never sees a gap.
    expect(answer).toContain("پشته LIFO است [1].");
    expect(answer).toContain(`- [1] ${messages.sourceLineText("notes.pdf", 5)}`);
    expect(answer).not.toContain(messages.sourceLineText("notes.pdf", 4));
  });

  it("passes the cancel signal to the model", async () => {
    vi.mocked(retrieveContext).mockResolvedValue([chunk(0, 1)]);
    const controller = new AbortController();

    await answerFromDocuments(8, "سؤال", "focused", { signal: controller.signal });

    expect(vi.mocked(chat).mock.calls[0]![0].signal).toBe(controller.signal);
  });
});

describe("pickDocument (which document a summary is about)", () => {
  // Newest first, like listCompletedDocuments.
  const documents = [
    { id: 3, filename: "CamScanner 05-18-2025.pdf" },
    { id: 2, filename: "جزوه درس آزمون نرم افزار.pdf" },
    { id: 1, filename: "DataStructure_Chapter1.pdf" },
  ];
  const hit = (documentId: number, rerankScore: number): RetrievedChunk => ({
    ...chunk(0, 1, true, documentId),
    distance: 0.3,
    rerankScore,
  });

  it("takes the only document", () => {
    expect(pickDocument([documents[2]!], "خلاصه کن", [])).toBe(documents[2]);
  });

  it("takes the document the question names", () => {
    expect(pickDocument(documents, "datastructure_chapter1 رو خلاصه کن", [hit(2, 5)])).toBe(documents[2]);
  });

  it("takes the document whose title or topic the question names (enriched documents)", () => {
    const enriched = [
      { ...documents[0]!, title: "هوش مصنوعی و سیستم‌های خبره", topics: ["سیستم خبره", "پایگاه دانش"] },
      documents[1]!,
      documents[2]!,
    ];

    expect(pickDocument(enriched, "سیستم خبره رو خلاصه کن", [hit(2, 5)])).toBe(enriched[0]);
  });

  it("otherwise takes the document most of the clearly matching hits come from", () => {
    const ranked = [hit(2, 4), hit(1, 1), hit(2, 0.5), hit(1, -2)];

    expect(pickDocument(documents, "تست نرم افزار رو خلاصه کن", ranked)).toBe(documents[1]);
  });

  it("falls back to the newest upload when nothing clearly matches", () => {
    expect(pickDocument(documents, "خلاصه کن", [hit(1, -6), hit(2, -7)])).toBe(documents[0]);
  });
});

describe("prefetchCandidates", () => {
  it("searches all documents, reranking the previous answer's hits with the results", async () => {
    const previous = [{ documentId: 1, chunkIndex: 4 }, { documentId: 2, chunkIndex: 5 }];

    await prefetchCandidates(8, "سؤال", previous);

    expect(rankedCandidates).toHaveBeenCalledWith(8, "سؤال", { include: previous });
  });

  it("searches normally without previous hits", async () => {
    await prefetchCandidates(8, "سؤال", null);

    expect(rankedCandidates).toHaveBeenCalledWith(8, "سؤال", { include: [] });
  });
});
