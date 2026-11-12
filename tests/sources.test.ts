import { describe, expect, it } from "vitest";
import {
  appendSources,
  buildSourceList,
  citedNumbers,
  formatChunks,
  isRefusal,
  numberSources,
  pagesMentioned,
} from "../src/rag/answer.js";

const chunk = (pageNumber: number | null) => ({
  filename: "notes.pdf",
  pageNumber,
  content: "x",
});

describe("sources", () => {
  it("deduplicates pages and skips unknown ones", () => {
    expect(buildSourceList([chunk(2), chunk(2), chunk(null), chunk(5)])).toEqual([
      "notes.pdf — صفحه 2",
      "notes.pdf — صفحه 5",
    ]);
  });

  it("cites only real hits, not neighbour chunks", () => {
    expect(
      buildSourceList([
        { ...chunk(3), isHit: true },
        { ...chunk(4), isHit: false },
      ]),
    ).toEqual(["notes.pdf — صفحه 3"]);
  });

  it("cites an enriched photo by its title, with no page (a photo has one)", () => {
    const photo = { filename: "capture_679.jpg", documentTitle: "معیارهای ارزیابی رگرسیون", pageNumber: 1, content: "x" };

    expect(buildSourceList([photo, chunk(2), { ...photo, documentTitle: null, filename: "photo-2.jpg" }])).toEqual([
      "عکس «معیارهای ارزیابی رگرسیون»",
      "notes.pdf — صفحه 2",
      "photo-2.jpg",
    ]);
  });

  it("returns the answer unchanged when there are no sources", () => {
    expect(appendSources("answer", [chunk(null)])).toBe("answer");
  });

  it("appends a sources section", () => {
    expect(appendSources("answer", [chunk(1)])).toContain("- notes.pdf — صفحه 1");
  });
});

describe("numbered sources", () => {
  const context = [
    { ...chunk(3), isHit: false },
    { ...chunk(4), isHit: true },
    { ...chunk(4), isHit: true },
    { ...chunk(5), isHit: true },
  ];
  const numbers = numberSources(context);

  it("numbers each page once, in reading order", () => {
    expect([...numbers.values()]).toEqual([1, 2, 3]);
    expect(formatChunks(context, numbers)).toContain("[منبع 2 — فایل: notes.pdf، صفحه PDF 4]");
  });

  it("lists only the sources the answer cites, neighbours included", () => {
    const answer = appendSources("پشته LIFO است [3]. مثالش [1، 3] است.", context, numbers);

    expect(answer).toContain("- [1] notes.pdf — صفحه 3");
    expect(answer).toContain("- [3] notes.pdf — صفحه 5");
    expect(answer).not.toContain("صفحه 4");
  });

  it("reads Persian digits and ignores unknown numbers and code", () => {
    expect(citedNumbers("نکته [۲]. کد `a[1]` و arr[3] و [9]")).toEqual(new Set([2, 9]));
    expect(appendSources("نکته [9]", context, numbers)).toContain("- [2] notes.pdf — صفحه 4");
  });

  it("falls back to the real hits when nothing is cited", () => {
    const answer = appendSources("پاسخ بدون شماره", context, numbers);

    expect(answer).toContain("- [2] notes.pdf — صفحه 4");
    expect(answer).toContain("- [3] notes.pdf — صفحه 5");
    expect(answer).not.toContain("صفحه 3");
  });

  it("adds no sources to a refusal", () => {
    const refusal = "در منابع اطلاعاتی درباره مرتب‌سازی سریع وجود ندارد.";

    expect(isRefusal(refusal)).toBe(true);
    expect(appendSources(refusal, context, numbers)).toBe(refusal);
  });

  it("reads a run of brackets as several citations", () => {
    expect(citedNumbers("سه محرک اصلی [1][3]. پایان [2، ۴]")).toEqual(new Set([1, 3, 2, 4]));
    expect(citedNumbers("کد a[1][2] نقل قول نیست")).toEqual(new Set());
  });

  it("treats an answer that opens with a refusal as a refusal, even if it then cites what is covered", () => {
    const refusal =
      "بر اساس منابع ارائه‌شده، هیچ اطلاعاتی در مورد الگوریتم بلمن-فورد وجود ندارد. منابع فقط به پریم و کروسکال پرداخته‌اند [1][2].";

    expect(isRefusal(refusal)).toBe(true);
    expect(appendSources(refusal, context, numbers)).toBe(refusal);
  });

  it("does not take a content sentence with 'وجود ندارد' for a refusal", () => {
    expect(isRefusal("در پشته دسترسی تصادفی وجود ندارد [2].")).toBe(false);
    expect(isRefusal("در آرایه محدودیتی برای اندازه وجود ندارد؛ پشته LIFO است [2].")).toBe(false);
  });

  it("recognises refusals that name the missing topic (near-miss answers, 2026-11-12)", () => {
    const refusals = [
      "بر اساس منابع ارائه‌شده، هیچ اشاره‌ای به میزان دقیق زلزله لیسبون به صورت «ریشتر» نشده است. تنها اطلاعات موجود درباره شدت آن این است [2].",
      "متن ارائه‌شده در منابع، توضیحی درباره تکنیک **Pairwise** یا نحوه کاهش تعداد موارد تست با این روش خاص ندارد. منابع به تقسیم‌بندی هم‌ارزی اشاره کرده‌اند [4].",
      "بر اساس متن ارائه‌شده در منابع، هیچ اشاره‌ای به مفاهیم «زنجیره‌سازی رو به جلو» یا «زنجیره‌سازی رو به عقب» و تفاوت‌های آن‌ها نشده است. بنابراین نمی‌توان پاسخ دقیقی داد [1, 2, 3].",
      "بر اساس منابع ارائه‌شده، هیچ اشاره‌ای به «منطق فازی» و کاربرد آن در سیستم‌های خبره نشده است.",
      "با توجه به جزوه نمی‌توانم به این سؤال پاسخ بدهم.",
    ];

    for (const refusal of refusals) {
      expect(isRefusal(refusal)).toBe(true);
      expect(appendSources(refusal, context, numbers)).toBe(refusal);
    }
  });

  it("does not take a content sentence that mentions a topic for a refusal", () => {
    expect(isRefusal("مرتبه اجرایی دایجکسترا در منابع O(n2) ذکر شده است [2، 4]. به صف اولویت اشاره‌ای نشده.")).toBe(false);
    expect(isRefusal("این متن به سه مرحله اشاره دارد: تحلیل، طراحی و پیاده‌سازی [1].")).toBe(false);
  });

  it("keeps sources on a partial answer that cites them", () => {
    const partial = "پشته LIFO است [2]، اما درباره صف اطلاعاتی در منابع نیامده.";

    expect(isRefusal(partial)).toBe(false);
    expect(appendSources(partial, context, numbers)).toContain("- [2] notes.pdf — صفحه 4");
  });
});

describe("pagesMentioned", () => {
  it("finds single pages and ranges, in either digit set", () => {
    expect(
      pagesMentioned(["تعریف پشته (صفحه PDF 12)", "مثال‌ها در صفحه ۱۴ تا ۱۶ آمده‌اند"]),
    ).toEqual(new Set([12, 14, 15, 16]));
  });
});
