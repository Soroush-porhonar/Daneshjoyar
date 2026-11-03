import { describe, expect, it } from "vitest";
import {
  assessPage,
  hasReversedLines,
  hasReversedWords,
  isDegenerateOcr,
  normalizeText,
  repairReversedWords,
  reverseLineWords,
  reverseWordLetters,
} from "../src/rag/textQuality.js";

describe("normalizeText", () => {
  it("turns tabs and repeated spaces into single spaces", () => {
    expect(normalizeText("a\tb    c")).toBe("a b c");
  });

  it("converts Arabic presentation forms to regular letters", () => {
    expect(normalizeText("ﺑﺨﺶ")).toBe("بخش");
  });

  it("converts Arabic yeh and kaf to Persian ones", () => {
    expect(normalizeText("كتاب ي")).toBe("کتاب ی");
  });

  it("keeps the zero-width non-joiner used in Persian words", () => {
    expect(normalizeText("می‌کند")).toBe("می‌کند");
  });

  it("removes invisible direction marks and collapses blank lines", () => {
    expect(normalizeText("a‏\n\n\n\n b ")).toBe("a\n\nb");
  });
});

describe("assessPage", () => {
  const good = "این یک جمله کامل و سالم فارسی است که شامل چندین کلمه معمولی می‌باشد و هیچ مشکلی ندارد";
  const broken = "ب ط ور ک ل ی و ی ر و س ی ب ه ن ام ک ر و ن ا و ج ود د ا ش ت ک ه ا ز خ ا ن و ا د ه";

  it("accepts a healthy text layer", () => {
    expect(assessPage(good, 20)).toEqual({ ok: true });
  });

  it("flags pages with almost no text as image-only", () => {
    expect(assessPage("  12  ", 20)).toEqual({ ok: false, reason: "no text layer" });
  });

  it("flags Persian text whose letters are split by spaces", () => {
    expect(assessPage(broken, 20)).toEqual({ ok: false, reason: "broken letters" });
  });

  it("flags junk text layers (fonts mapped to digits and symbols)", () => {
    const junk = '2    2     2    2   " 8 ( 9 : * \' = 0 ( 2 $ 2 2 2 '.repeat(3);

    expect(assessPage(junk, 20)).toEqual({
      ok: false,
      reason: "junk text",
    });
  });

  it("accepts code-heavy slides", () => {
    const code = "مثال 1 : تابع فاکتوریل int fact (int n) { int f=1; for(i=1;i<=n;i++) f=f*i; return f; }";

    expect(assessPage(code, 20)).toEqual({ ok: true });
  });

  it("accepts text with many split letters that is still readable (measured: no OCR gain)", () => {
    // From the COVID PDF's text layer: ~40% isolated letters.
    const covid =
      "بطور کل ی و ی روس ی به نام کرونا وجود داشت ی ک سو ی ه جد ی د از خانواده کرونا که سال ۲۰۱۹ ظهور کرد و ا ی جاد عالئم تنفس ی م ی کرد";

    expect(assessPage(covid, 20)).toEqual({ ok: true });
  });

  it("does not treat the word و as a broken letter", () => {
    expect(assessPage(Array(20).fill("و").join(" ") + " " + good, 20)).toEqual({ ok: true });
  });
});

describe("isDegenerateOcr", () => {
  it("rejects empty output", () => {
    expect(isDegenerateOcr("  \n ")).toBe(true);
  });

  it("rejects output stuck repeating one line", () => {
    expect(isDegenerateOcr(Array(30).fill("same line").join("\n"))).toBe(true);
  });

  it("accepts normal multi-line output", () => {
    expect(isDegenerateOcr("line one\nline two\nline three")).toBe(false);
  });
});

describe("reversed letters in OCR output", () => {
  // Real output of the vision model for page 5 of the testing notes.
  const ocr =
    "تراهم یاه ینفریغ:\n" +
    "تراهم یاه ریز یارب لیدبت ندش هب کی رتست مرن رازفا بوخ یروض تسا .یارب نییعت هکنیا ایآ تست";
  const lisbon =
    "در تاریخ اروپا بعضی حوادث فقط به دلیل تعداد قربانیان یا میزان ویرانی اهمیت پیدا نمی کنند، " +
    "بلکه به این دلیل مهم می شوند که نگاه مردم به جهان را تغییر می دهند. این زلزله در اول نوامبر رخ داد.";

  it("detects words written with reversed letters", () => {
    expect(hasReversedWords(ocr)).toBe(true);
  });

  it("leaves correct Persian alone", () => {
    expect(hasReversedWords(lisbon)).toBe(false);
  });

  it("restores the letters of every Persian word and keeps English and digits", () => {
    expect(reverseWordLetters("تراهم یاه ینفریغ:")).toBe("مهارت های غیرفنی:");
    expect(reverseWordLetters("ار Test Case اه ۱۲")).toBe("را Test Case ها ۱۲");
  });
});

describe("reversed word order", () => {
  const reversed = [
    ".آمدم دنیا به مذهبی نیمه خانواده یک در",
    ".داشتم دوستان و خانواده با ناسازگاری سر",
    "که بودم خیابانی در زدن قدم حال در روز یک",
  ];
  const normal = [
    "در یک خانواده نیمه مذهبی به دنیا آمدم.",
    "با خانواده و دوستان ناسازگاری داشتم.",
    "روزی در خیابانی قدم می‌زدم که",
  ];
  const many = (lines: string[]) => [Array(5).fill(lines.join("\n")).join("\n")];

  it("detects lines whose punctuation is at the start", () => {
    expect(hasReversedLines(many(reversed))).toBe(true);
  });

  it("leaves normal Persian alone", () => {
    expect(hasReversedLines(many(normal))).toBe(false);
  });

  it("needs enough lines to decide", () => {
    expect(hasReversedLines([reversed.join("\n")])).toBe(false);
  });

  it("restores reading order and moves punctuation to the end", () => {
    expect(reverseLineWords(reversed[0]!)).toBe(normal[0]);
  });
});

describe("repairReversedWords", () => {
  const counts = new Map([
    ["در", 838],
    ["رد", 20],
    ["به", 660],
    ["برای", 218],
    ["یک", 212],
    ["کی", 8],
    ["کرد", 61],
    ["درک", 7],
  ]);

  it("flips only the words whose reversed spelling is much more common", () => {
    expect(repairReversedWords("کی سیستم خبره یارب لح مسائل هب کار میرود", counts)).toBe(
      "یک سیستم خبره برای لح مسائل به کار میرود",
    );
  });

  it("leaves correct words alone, including real words whose reverse is only somewhat more common", () => {
    expect(repairReversedWords("در این درک کرد", counts)).toBe("در این درک کرد");
  });

  it("does not touch English, digits or single letters", () => {
    expect(repairReversedWords("rule هب 29119 و", counts)).toBe("rule به 29119 و");
  });

  it("uses the shipped word list by default", () => {
    expect(repairReversedWords("هب")).toBe("به");
  });
});
