import { describe, expect, it } from "vitest";
import { citedPages, scoreRoute } from "../scripts/evalHelpers.js";
import { SOURCES_HEADING, sourceLineText } from "../src/messages.js";

describe("scoreRoute (eval:router labels)", () => {
  const said = (route: "document" | "chat", retrievalMode: "focused" | "multi_part" | "broad" = "focused") => ({
    route,
    retrievalMode,
  });

  it("needs the route and the one labelled mode", () => {
    expect(scoreRoute({ route: "document", mode: "broad" }, said("document", "broad"))).toMatchObject({
      routeOk: true,
      exactOk: true,
      expectedLabel: "doc:broad",
      actualLabel: "doc:broad",
    });
    expect(scoreRoute({ route: "document", mode: "broad" }, said("document", "focused"))).toMatchObject({
      routeOk: true,
      exactOk: false,
      expectedLabel: "doc:broad",
      actualLabel: "doc:focused",
    });
  });

  it("ignores the mode of a chat message", () => {
    expect(scoreRoute({ route: "chat" }, said("chat", "broad"))).toMatchObject({
      exactOk: true,
      expectedLabel: "chat",
      actualLabel: "chat",
    });
  });

  it("accepts any of several labelled modes", () => {
    const expected = { route: "document" as const, mode: ["focused" as const, "multi_part" as const] };

    expect(scoreRoute(expected, said("document", "multi_part"))).toMatchObject({
      exactOk: true,
      expectedLabel: "doc:multi_part",
    });
    expect(scoreRoute(expected, said("document", "broad"))).toMatchObject({
      routeOk: true,
      exactOk: false,
      expectedLabel: "doc:focused",
    });
  });

  it("labels questions about the document itself 'info' and ignores their mode", () => {
    expect(scoreRoute({ route: "document_info" }, { route: "document_info", retrievalMode: "broad" })).toMatchObject({
      routeOk: true,
      exactOk: true,
      expectedLabel: "info",
      actualLabel: "info",
    });
    expect(scoreRoute({ route: "document_info" }, said("document", "broad"))).toMatchObject({
      routeOk: false,
      actualLabel: "doc:broad",
    });
  });

  it("scores only the route when no mode is labelled", () => {
    expect(scoreRoute({ route: "document" }, said("document", "broad")).exactOk).toBe(true);
    expect(scoreRoute({ route: "document" }, said("chat"))).toMatchObject({
      routeOk: false,
      exactOk: false,
      expectedLabel: "doc:focused",
      actualLabel: "chat",
    });
  });
});

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
