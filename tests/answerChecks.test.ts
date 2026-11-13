import { describe, expect, it } from "vitest";
import {
  citedSentences,
  comparable,
  coversPage,
  missingKeywords,
  persianShare,
  scoreAnswer,
  separation,
} from "../scripts/answerChecks.js";
import { NO_RELEVANT_CONTENT_TEXT, SOURCES_HEADING, sourceLineText } from "../src/messages.js";

describe("comparable (eval: keyword matching)", () => {
  it("ignores spacing, half-spaces and digit scripts", () => {
    expect(comparable("برنامه‌نویسی  پویا ۱۲")).toBe(comparable("برنامه نویسی پویا 12"));
    expect(comparable("O(n²)")).toBe("o(n2)");
    expect(comparable("x₁ + xⁿ")).toBe("x1+xn");
  });

  it("reads formulas like the bot sends them", () => {
    expect(comparable("مرتبه آن $O(n \\log n)$ است")).toContain("nlogn");
    expect(comparable("$O(n^2 \\log n)$")).toBe("o(n2logn)");
    expect(comparable("\\(\\frac{1}{n}\\)")).toBe("1/n");
  });

  it("drops LaTeX markup left outside math delimiters but keeps the letters", () => {
    expect(comparable("O(n \\log n)")).toBe("o(nlogn)");
    expect(comparable("\\text{mean}")).toBe("mean");
  });
});

describe("missingKeywords", () => {
  it("passes an entry when any accepted form is in the answer", () => {
    const body = "سیستم توانایی استنتاج دارد";

    expect(missingKeywords(body, [["استنباط", "استنتاج"]])).toEqual([]);
    expect(missingKeywords(body, ["استنباط"])).toEqual(["استنباط"]);
  });

  it("names a missing entry by its first form", () => {
    expect(missingKeywords("پاسخ", [["نویسنده", "توسعه‌دهنده"], "پاسخ"])).toEqual(["نویسنده"]);
  });

  it("needs every entry", () => {
    expect(missingKeywords("پشته و صف", ["پشته", "صف", "درخت"])).toEqual(["درخت"]);
    expect(missingKeywords("هر چیزی")).toEqual([]);
  });
});

describe("persianShare", () => {
  it("is 1 for Persian prose and 0 for English prose", () => {
    expect(persianShare("این یک پاسخ فارسی است")).toBe(1);
    expect(persianShare("an English answer")).toBe(0);
  });

  it("does not count code, formulas and parenthesised Latin terms", () => {
    expect(persianShare("حلقه `for (i = 0; i < n; i++)` را ببین")).toBe(1);
    expect(persianShare("مرتبه $O(n \\log n)$ است")).toBe(1);
    expect(persianShare("توسعه رفتارمحور (Behavior Driven Development) یعنی")).toBe(1);
  });

  it("keeps a Persian answer that lists English tool names above the pass mark", () => {
    const answer = [
      "برای BDD (Behavior Driven Development) از ابزارهای زیر استفاده می‌شود:",
      "*   Cucumber (پایتون/جاوا/JS) [2]",
      "*   SpecFlow (C#) [3]",
      "*   Behave (Python) [3]",
    ].join("\n");

    expect(persianShare(answer)).toBeGreaterThan(0.5);
  });
});

describe("citedSentences (eval: each citation against its source)", () => {
  it("pairs each sentence with the sources it cites", () => {
    const body =
      "برنامه‌نویسی شی‌گرا در سال ۱۹۸۰ معرفی شد [2]. این رویکرد بر چهار اصل استوار است [5]، [7]. جمله‌ای بدون ارجاع هم هست.";

    expect(citedSentences(body)).toEqual([
      { sentence: "برنامه‌نویسی شی‌گرا در سال ۱۹۸۰ معرفی شد.", numbers: [2] },
      { sentence: "این رویکرد بر چهار اصل استوار است.", numbers: [5, 7] },
    ]);
  });

  it("gives a citation written after the full stop to the sentence before it", () => {
    const body = [
      "*   **هدف:** اثبات صحت عملکرد یک سیستم توسط تولیدکننده آن است. [2]",
      "*   این مرحله پیش از عرضه عمومی انجام می‌شود. [4] همچنین کنترل محیط در آن بیشتر است [۳].",
    ].join("\n");

    expect(citedSentences(body)).toEqual([
      { sentence: "هدف: اثبات صحت عملکرد یک سیستم توسط تولیدکننده آن است.", numbers: [2] },
      { sentence: "این مرحله پیش از عرضه عمومی انجام می‌شود.", numbers: [4] },
      { sentence: "همچنین کنترل محیط در آن بیشتر است.", numbers: [3] },
    ]);
  });

  it("reads a list item with the line that introduces the list", () => {
    const body = [
      "رسمی‌ترین نوع بازبینی، Inspection است [2]. این نوع بازبینی نقش‌های زیر را دارد:",
      "*   Moderator (هدایت جلسه) [2]",
      "*   Reader (خواننده سند) [2]",
      "",
      "پس از آن جلسه پیگیری برگزار می‌شود [3].",
      "*   این مورد بعد از متن عادی آمده است [3]",
    ].join("\n");

    expect(citedSentences(body)).toEqual([
      { sentence: "رسمی‌ترین نوع بازبینی، Inspection است.", numbers: [2] },
      { sentence: "این نوع بازبینی نقش‌های زیر را دارد: Moderator (هدایت جلسه)", numbers: [2] },
      { sentence: "این نوع بازبینی نقش‌های زیر را دارد: Reader (خواننده سند)", numbers: [2] },
      { sentence: "پس از آن جلسه پیگیری برگزار می‌شود.", numbers: [3] },
      { sentence: "این مورد بعد از متن عادی آمده است", numbers: [3] },
    ]);
  });

  it("drops list numbers, and skips headings and code", () => {
    const body = [
      "**مراحل** [1]",
      "1. **فاز ۱: تحلیل و طراحی**: خروجی آن الگوریتم است [3]",
      "۲) فاز پیاده‌سازی برنامه قابل اجرا می‌دهد [1][4]",
      "عنصر `a[1]` اولین خانه آرایه در این مثال است.",
    ].join("\n");

    expect(citedSentences(body)).toEqual([
      { sentence: "فاز ۱: تحلیل و طراحی: خروجی آن الگوریتم است", numbers: [3] },
      { sentence: "فاز پیاده‌سازی برنامه قابل اجرا می‌دهد", numbers: [1, 4] },
    ]);
  });
});

describe("coversPage (eval: was the expected page given to the model?)", () => {
  const chunks = [
    { documentId: 1, pageNumber: 3 },
    { documentId: 1, pageNumber: 7, pageEnd: 9 },
    { documentId: 2, pageNumber: 5 },
    { documentId: 1, pageNumber: null },
  ];

  it("needs the right document and page, and reads a chunk that crosses pages", () => {
    expect(coversPage(chunks, 1, [3])).toBe(true);
    expect(coversPage(chunks, 1, [8])).toBe(true);
    expect(coversPage(chunks, 1, [5])).toBe(false);
    expect(coversPage(chunks, 2, [4, 5])).toBe(true);
    expect(coversPage([], 1, [3])).toBe(false);
  });
});

describe("separation (eval: does a score tell supported citations from unsupported ones?)", () => {
  const pair = (score: number, supported: boolean) => ({ score, supported });

  it("finds a clean cut-off in the middle of the gap", () => {
    const result = separation([pair(5, true), pair(3, true), pair(2, true), pair(-4, false), pair(-6, false)]);

    expect(result).toEqual({ threshold: -1, accuracy: 1, falsePositives: 0, falseNegatives: 0, auc: 1 });
  });

  it("reports the errors of the best cut-off when the groups overlap", () => {
    // One unsupported pair scores above two supported ones.
    const result = separation([pair(6, true), pair(4, true), pair(1, true), pair(0, true), pair(2, false), pair(-5, false)]);

    expect(result.accuracy).toBeCloseTo(5 / 6);
    expect(result.falsePositives + result.falseNegatives).toBe(1);
    expect(result.auc).toBeCloseTo(6 / 8);
  });

  it("says so when the score separates nothing", () => {
    const result = separation([pair(1, true), pair(1, false), pair(1, true), pair(1, false)]);

    expect(result.auc).toBe(0.5);
    expect(result.accuracy).toBe(0.5);
  });

  it("handles a single group and no pairs", () => {
    expect(separation([pair(2, true), pair(3, true)])).toMatchObject({ accuracy: 1, auc: 1 });
    expect(separation([])).toMatchObject({ accuracy: 1, auc: 1 });
  });
});

describe("scoreAnswer", () => {
  const question = {
    id: "q",
    type: "exact_term",
    filename: "notes.pdf",
    expectedPages: [3],
    mustInclude: ["آخرین"],
  };
  const withSources = (body: string, page: number) =>
    `${body}\n\n${SOURCES_HEADING}\n- [1] ${sourceLineText("notes.pdf", page)}`;

  it("does not ask an answer about the file itself for citations", () => {
    const info = { ...question, route: "document_info" as const };
    expect(scoreAnswer(info, "📄 درباره «notes.pdf»:\n\nاین جزوه درباره آخرین مباحث پشته است.")).toMatchObject({
      cites: null,
      inline: null,
      passed: true,
    });
    expect(scoreAnswer(info, "این جزوه درباره صف است.").passed).toBe(false); // keyword missing
  });

  it("passes an answer that cites the expected page and has the keywords", () => {
    expect(scoreAnswer(question, withSources("آخرین عنصر اول خارج می‌شود [1].", 3))).toMatchObject({
      cites: true,
      inline: true,
      missing: [],
      refused: false,
      passed: true,
    });
  });

  it("fails on another page, and on a missing keyword", () => {
    expect(scoreAnswer(question, withSources("آخرین عنصر اول خارج می‌شود [1].", 4))).toMatchObject({
      cites: false,
      passed: false,
    });
    expect(scoreAnswer(question, withSources("پشته یک ساختار است [1].", 3))).toMatchObject({
      missing: ["آخرین"],
      passed: false,
    });
  });

  it("passes an unanswerable question only when the bot refuses", () => {
    const negative = { id: "n", type: "negative", filename: "notes.pdf", expectedPages: [] };

    expect(scoreAnswer(negative, NO_RELEVANT_CONTENT_TEXT)).toMatchObject({ cites: null, refused: true, passed: true });
    expect(scoreAnswer(negative, withSources("مرتب‌سازی سریع این‌طور کار می‌کند [1].", 3)).passed).toBe(false);
  });
});
