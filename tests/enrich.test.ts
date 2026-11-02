import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/enrichment.js", () => ({
  loadDocumentForEnrichment: vi.fn(),
  saveEnrichment: vi.fn(),
}));
vi.mock("../src/llm/ollamaClient.js", () => ({ chat: vi.fn() }));
vi.mock("../src/rag/embeddings.js", () => ({ generateEmbeddings: vi.fn() }));

const { enrichDocument, fitSummaries, parseChunkContext, parseProfile } = await import(
  "../src/rag/enrich.js"
);
const { foregroundIdle, startForegroundWork } = await import("../src/llm/priority.js");
const { loadDocumentForEnrichment, saveEnrichment } = await import("../src/db/enrichment.js");
const { chat } = await import("../src/llm/ollamaClient.js");
const { generateEmbeddings } = await import("../src/rag/embeddings.js");
const { logger } = await import("../src/logger.js");

const chunk = (id: number, page: number, content = `متن صفحه ${page}`) => ({
  id,
  chunkIndex: id - 1,
  pageNumber: page,
  pageEnd: page,
  sectionTitle: null,
  content,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.mocked(generateEmbeddings).mockImplementation(async (texts) => texts.map(() => [0.1]));
});

describe("priority (answers before background work)", () => {
  it("background work waits until every running answer is done", async () => {
    const first = startForegroundWork();
    const second = startForegroundWork();
    let idle = false;
    const waiting = foregroundIdle().then(() => (idle = true));

    first();
    first(); // calling twice counts once
    await Promise.resolve();
    expect(idle).toBe(false);

    second();
    await waiting;
    expect(idle).toBe(true);
  });

  it("is idle right away when nothing runs", async () => {
    await expect(foregroundIdle()).resolves.toBeUndefined();
  });
});

describe("parsers", () => {
  it("reads a profile and caps topics at ten", () => {
    const topics = Array.from({ length: 12 }, (_, i) => `مبحث ${i}`);
    expect(parseProfile(JSON.stringify({ title: " سیستم خبره ", summary: "خلاصه", topics }), "x.pdf")).toEqual({
      title: "سیستم خبره",
      summary: "خلاصه",
      topics: topics.slice(0, 10),
    });
  });

  it("falls back to the filename when the profile is unusable", () => {
    expect(parseProfile("not json", "CamScanner 05.pdf")).toEqual({
      title: "CamScanner 05",
      summary: "",
      topics: [],
    });
  });

  it("reads a chunk's context and at most three questions; null without context", () => {
    expect(parseChunkContext(JSON.stringify({ context: "زمینه", questions: ["الف", "", "ب", "ج", "د"] }))).toEqual({
      context: "زمینه",
      questions: ["الف", "ب", "ج"],
    });
    expect(parseChunkContext(JSON.stringify({ context: " ", questions: ["الف"] }))).toBeNull();
    expect(parseChunkContext("{broken")).toBeNull();
  });

  it("gives every section summary its share of the profile input", () => {
    expect(fitSummaries(["a".repeat(10), "b".repeat(3)], 10)).toEqual(["aaaaa…", "bbb"]);
  });
});

describe("enrichDocument", () => {
  it("summarises sections, builds a profile, adds context and questions per chunk, then saves", async () => {
    vi.mocked(loadDocumentForEnrichment).mockResolvedValue({
      filename: "CamScanner.pdf",
      chunks: [chunk(1, 1), chunk(2, 2)],
    });
    vi.mocked(chat).mockImplementation(async (request) => {
      if (!request.format) return "خلاصه بخش (صفحه PDF 1)";
      if ("title" in (request.format.properties as object)) {
        return JSON.stringify({ title: "سیستم‌های خبره", summary: "درباره سیستم خبره", topics: ["تعریف"] });
      }
      return JSON.stringify({ context: "از جزوه سیستم‌های خبره", questions: ["سیستم خبره چیه؟"] });
    });

    await enrichDocument(58);

    const [documentId, profile, sections, chunks] = vi.mocked(saveEnrichment).mock.calls[0]!;
    expect(documentId).toBe(58);
    expect(profile.title).toBe("سیستم‌های خبره");
    expect(sections).toEqual([{ sectionIndex: 0, pageStart: 1, pageEnd: 2, summary: "خلاصه بخش (صفحه PDF 1)" }]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ chunkId: 1, context: "از جزوه سیستم‌های خبره" });
    expect(chunks[0]!.questions).toEqual([{ question: "سیستم خبره چیه؟", embedding: [0.1] }]);

    // The chunk is embedded with the document title and its context in front.
    const embedded = vi.mocked(generateEmbeddings).mock.calls.flatMap(([texts]) => texts);
    expect(embedded[0]).toBe("سیستم‌های خبره\nاز جزوه سیستم‌های خبره\nمتن صفحه 1");
  });

  it("skips a chunk whose context is unusable instead of failing the document", async () => {
    vi.mocked(loadDocumentForEnrichment).mockResolvedValue({ filename: "a.pdf", chunks: [chunk(1, 1), chunk(2, 2)] });
    let chunkCalls = 0;
    vi.mocked(chat).mockImplementation(async (request) => {
      if (!request.format) return "خلاصه";
      if ("title" in (request.format.properties as object)) return JSON.stringify({ title: "t", summary: "", topics: [] });
      return ++chunkCalls === 1 ? "oops" : JSON.stringify({ context: "زمینه", questions: [] });
    });

    await enrichDocument(5);

    const chunks = vi.mocked(saveEnrichment).mock.calls[0]![3];
    expect(chunks.map((c) => c.chunkId)).toEqual([2]);
  });

  it("fails for a document without chunks (the worker marks it failed)", async () => {
    vi.mocked(loadDocumentForEnrichment).mockResolvedValue(null);

    await expect(enrichDocument(9)).rejects.toThrow();
    expect(saveEnrichment).not.toHaveBeenCalled();
  });
});
