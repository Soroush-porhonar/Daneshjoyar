import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { parseClassification, resolveRoute } from "../src/rag/router.js";

describe("parseClassification", () => {
  it("accepts a valid document route", () => {
    expect(
      parseClassification('{"route":"document","retrievalMode":"broad"}'),
    ).toEqual({ route: "document", retrievalMode: "broad" });
  });

  it("forces focused retrieval for chat", () => {
    expect(
      parseClassification('{"route":"chat","retrievalMode":"broad"}'),
    ).toEqual({ route: "chat", retrievalMode: "focused" });
  });

  it("reads the follow-up decision and the standalone question", () => {
    expect(
      parseClassification(
        '{"route":"document","retrievalMode":"focused","dependsOnHistory":true,"standaloneQuestion":"«مرتبه اجرایی پریم چیست؟»"}',
      ),
    ).toEqual({
      route: "document",
      retrievalMode: "focused",
      dependsOnHistory: true,
      standaloneQuestion: "مرتبه اجرایی پریم چیست؟",
    });
  });

  it("ignores the standalone question of a message that stands alone", () => {
    expect(
      parseClassification('{"route":"document","retrievalMode":"focused","dependsOnHistory":false,"standaloneQuestion":"x"}'),
    ).toEqual({ route: "document", retrievalMode: "focused", dependsOnHistory: false, standaloneQuestion: null });
  });

  it("drops an unusable standalone question (several lines), so the caller rewrites", () => {
    const parsed = parseClassification(
      '{"route":"chat","retrievalMode":"focused","dependsOnHistory":true,"standaloneQuestion":"خط اول\\nخط دوم"}',
    );
    expect(parsed).toEqual({ route: "chat", retrievalMode: "focused", dependsOnHistory: true, standaloneQuestion: null });
  });

  it.each([
    "not json",
    '{"route":"other","retrievalMode":"focused"}',
    '{"route":"document_info","retrievalMode":"focused"}',
    '{"route":"document","retrievalMode":"huge"}',
    '{"route":"document"}',
  ])("rejects %s", (content) => {
    expect(() => parseClassification(content)).toThrow();
  });
});

describe("resolveRoute", () => {
  const chat = { route: "chat" as const, retrievalMode: "focused" as const };
  const strong = config.reranker.relevantScore + 1;
  const weak = config.reranker.relevantScore - 1;

  it("answers from the notes when the router said chat but a chunk clearly matches", () => {
    expect(resolveRoute(chat, strong)).toEqual({ route: "document", retrievalMode: "focused" });
  });

  it("keeps chat when nothing matches clearly or nothing was found", () => {
    expect(resolveRoute(chat, weak)).toBe(chat);
    expect(resolveRoute(chat, undefined)).toBe(chat);
  });

  it("never changes a document route", () => {
    const broad = { route: "document" as const, retrievalMode: "broad" as const };

    expect(resolveRoute(broad, weak)).toBe(broad);
  });
});
