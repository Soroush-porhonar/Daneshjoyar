import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The test environment disables the reranker; switch it on for these tests.
vi.mock("../src/config.js", async (importOriginal) => {
  const { config } = await importOriginal<typeof import("../src/config.js")>();
  return { config: { ...config, reranker: { ...config.reranker, enabled: true } } };
});

const { rerankChunks } = await import("../src/rag/rerank.js");
const { logger } = await import("../src/logger.js");

const fetchMock = vi.fn();
const chunks = [{ content: "الف" }, { content: "ب" }, { content: "ج" }];

const reply = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rerankChunks", () => {
  it("orders chunks by relevance score, best first", async () => {
    reply({
      results: [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.9 },
        { index: 2, relevance_score: 0.5 },
      ],
    });

    const ranked = await rerankChunks("سؤال", chunks);

    expect(ranked.map((c) => c.content)).toEqual(["ب", "ج", "الف"]);
  });

  it("sends the question and the chunk texts", async () => {
    reply({ results: chunks.map((_, index) => ({ index, relevance_score: 0 })) });

    await rerankChunks("سؤال", chunks);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({ query: "سؤال", documents: ["الف", "ب", "ج"] });
  });

  it("sends the slide title with the chunk, like the embedded text", async () => {
    reply({ results: [0, 1].map((index) => ({ index, relevance_score: 0 })) });

    await rerankChunks("سؤال", [
      { content: "متن اسلاید", sectionTitle: "صف" },
      { content: "صف\nمتن", sectionTitle: "صف" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.documents).toEqual(["صف\nمتن اسلاید", "صف\nمتن"]);
  });

  it("keeps the search order when the service is down", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    expect(await rerankChunks("سؤال", chunks)).toEqual(chunks);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps the search order on an HTTP error", async () => {
    reply({ error: "boom" }, 500);

    expect(await rerankChunks("سؤال", chunks)).toEqual(chunks);
  });

  it("rejects a response that does not cover every chunk", async () => {
    reply({ results: [{ index: 0, relevance_score: 1 }] });

    expect(await rerankChunks("سؤال", chunks)).toEqual(chunks);
  });

  it("rejects out-of-range indexes", async () => {
    reply({
      results: [
        { index: 0, relevance_score: 1 },
        { index: 1, relevance_score: 1 },
        { index: 7, relevance_score: 1 },
      ],
    });

    expect(await rerankChunks("سؤال", chunks)).toEqual(chunks);
  });

  it("does not call the service for fewer than two chunks", async () => {
    expect(await rerankChunks("سؤال", [chunks[0]!])).toEqual([chunks[0]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
