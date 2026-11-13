import { describe, expect, it } from "vitest";
import { extractConcepts } from "../src/rag/concepts.js";

describe("extractConcepts", () => {
  it("splits a question about two concepts at «و»", () => {
    expect(extractConcepts("زلزله لیسبون چه زمانی رخ داد و شهر پس از آن چگونه بازسازی شد؟")).toEqual([
      "زلزله لیسبون چه زمانی رخ داد",
      "شهر پس از آن چگونه بازسازی شد",
    ]);
  });

  it("keeps a coordinated pair of words together («مزایا و معایب»)", () => {
    expect(extractConcepts("استفاده از بازگشت چه مزایا و معایبی دارد؟")).toEqual([]);
  });

  it("returns nothing for a single-concept question", () => {
    expect(extractConcepts("LIFO یعنی چه؟")).toEqual([]);
    expect(extractConcepts("اصول شی گرایی رو یکی یکی توضیح بده")).toEqual([]);
  });

  it("splits at «،» too and keeps at most four parts", () => {
    const question = "تعریف پشته را بگو، تعریف صف را بگو، تعریف درخت را بگو، تعریف گراف را بگو، تعریف هیپ را بگو";
    expect(extractConcepts(question)).toHaveLength(4);
  });
});
