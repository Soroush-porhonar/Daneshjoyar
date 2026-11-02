import { describe, expect, it } from "vitest";
import { citedPages } from "../scripts/evalHelpers.js";
import { SOURCES_HEADING, sourceLineText } from "../src/messages.js";

describe("citedPages (eval: the right page of the right file)", () => {
  const answer = [
    "پشته LIFO است [1]. درخت [2].",
    "",
    SOURCES_HEADING,
    `- [1] ${sourceLineText("notes.pdf", 3)}`,
    `- [2] ${sourceLineText("other.pdf", 5)}`,
    `- [3] ${sourceLineText("notes.pdf", 7, 9)}`,
  ].join("\n");

  it("returns only the pages cited in the given file, ranges expanded", () => {
    expect(citedPages(answer, "notes.pdf")).toEqual([3, 7, 8, 9]);
    expect(citedPages(answer, "other.pdf")).toEqual([5]);
  });

  it("finds nothing without a sources section", () => {
    expect(citedPages("پاسخ بدون منبع", "notes.pdf")).toEqual([]);
  });
});
