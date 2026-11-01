import { describe, expect, it } from "vitest";
import { mergeContext, relevantHits } from "../src/rag/retrieve.js";
import type { ContextChunk, RetrievedChunk } from "../src/rag/retrieve.js";

const chunk = (chunkIndex: number): ContextChunk => ({
  documentId: 1,
  filename: "a.pdf",
  pageNumber: chunkIndex,
  chunkIndex,
  content: `c${chunkIndex}`,
  isHit: false,
});

const indexes = (chunks: ContextChunk[]) => chunks.map((c) => c.chunkIndex);

describe("mergeContext", () => {
  it("returns hits and neighbours in reading order without duplicates", () => {
    const merged = mergeContext([chunk(10)], [chunk(9), chunk(11), chunk(9)], 5);

    expect(indexes(merged)).toEqual([9, 10, 11]);
  });

  it("never drops a hit to make room for a neighbour", () => {
    const merged = mergeContext([chunk(10), chunk(20)], [chunk(9), chunk(19)], 2);

    expect(indexes(merged)).toEqual([10, 20]);
  });

  it("prefers neighbours of the best-ranked hit when capped", () => {
    const merged = mergeContext(
      [chunk(30), chunk(10)],
      [chunk(9), chunk(11), chunk(29), chunk(31)],
      4,
    );

    expect(indexes(merged)).toEqual([10, 29, 30, 31]);
  });

  it("adds the hit's section, closest slides first", () => {
    const inSection = (chunkIndex: number) => ({ ...chunk(chunkIndex), sectionIndex: 4 });
    const hit = inSection(12);

    const merged = mergeContext(
      [hit],
      [inSection(10), inSection(11), inSection(13), inSection(16), chunk(5)],
      4,
    );

    expect(indexes(merged)).toEqual([11, 12, 13, 10].sort((a, b) => a - b));
  });

  it("serves the best hit's section before a weaker hit's neighbours", () => {
    const merged = mergeContext(
      [{ ...chunk(20), sectionIndex: 1 }, chunk(40)],
      [chunk(41), { ...chunk(22), sectionIndex: 1 }, { ...chunk(23), sectionIndex: 1 }],
      4,
    );

    expect(indexes(merged)).toEqual([20, 22, 23, 40]);
  });

  it("handles no neighbours", () => {
    expect(indexes(mergeContext([chunk(3), chunk(1)], [], 5))).toEqual([1, 3]);
  });
});

describe("relevantHits", () => {
  const hit = (chunkIndex: number, rerankScore?: number): RetrievedChunk => ({
    ...chunk(chunkIndex),
    distance: 0.3,
    ...(rerankScore === undefined ? {} : { rerankScore }),
  });

  it("drops hits the reranker scored below the minimum", () => {
    const kept = relevantHits([hit(1, 2.5), hit(2, -1), hit(3, 0)], 0);

    expect(kept.map((c) => c.chunkIndex)).toEqual([1, 3]);
  });

  it("keeps everything when no minimum is set", () => {
    expect(relevantHits([hit(1, -5), hit(2, -9)], null)).toHaveLength(2);
  });

  it("keeps unscored hits (reranker off or down)", () => {
    expect(relevantHits([hit(1), hit(2)], 0)).toHaveLength(2);
  });
});
