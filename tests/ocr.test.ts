import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageText, PdfHandle } from "../src/rag/pdf.js";

// The vision model is replaced by a fake that "reads" a page image.
vi.mock("../src/llm/ollamaClient.js", () => ({ chat: vi.fn() }));
// A copy of the OCR settings that tests may change (e.g. set a page cap).
vi.mock("../src/config.js", async (importOriginal) => {
  const { config } = await importOriginal<typeof import("../src/config.js")>();
  return { config: { ...config, ocr: { ...config.ocr } } };
});

const { config } = await import("../src/config.js");
const ocrSettings = config.ocr as { maxPages: number };
const { cleanOcrText, extractPages } = await import("../src/rag/ocr.js");
const { chat } = await import("../src/llm/ollamaClient.js");
const { logger } = await import("../src/logger.js");

const GOOD_TEXT = "این یک صفحه سالم با متن کامل فارسی است که نیازی به خواندن دوباره ندارد.";

const textPage = (pageNumber: number): PageText => ({
  pageNumber,
  text: GOOD_TEXT,
  method: "text",
});
const imagePage = (pageNumber: number): PageText => ({ pageNumber, text: "", method: "text" });

function fakePdf(pages: PageText[]): PdfHandle {
  return {
    pages,
    renderPage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ocrSettings.maxPages = Infinity;
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.mocked(chat).mockImplementation(async () => "متن خوانده‌شده از تصویر صفحه");
});

describe("extractPages", () => {
  it("keeps good text pages and never calls the vision model for them", async () => {
    const pdf = fakePdf([textPage(1), textPage(2)]);

    const result = await extractPages(pdf);

    expect(result.ocrPages).toBe(0);
    expect(result.pages).toEqual(pdf.pages);
    expect(chat).not.toHaveBeenCalled();
  });

  it("OCRs only the pages without a usable text layer", async () => {
    const pdf = fakePdf([textPage(1), imagePage(2), textPage(3)]);

    const result = await extractPages(pdf);

    expect(pdf.renderPage).toHaveBeenCalledTimes(1);
    expect(pdf.renderPage).toHaveBeenCalledWith(2, expect.any(Number));
    expect(result.ocrPages).toBe(1);
    expect(result.pages.map((page) => page.method)).toEqual(["text", "ocr", "text"]);
    expect(result.pages[1]!.text).toBe("متن خوانده‌شده از تصویر صفحه");
  });

  it("sends the page image to the model as base64", async () => {
    await extractPages(fakePdf([imagePage(1)]));

    const request = vi.mocked(chat).mock.calls[0]![0];
    expect(request.messages[0]!.images).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
    expect(request.options?.temperature).toBe(0);
  });

  it("keeps the text layer when the model output is a repetition loop", async () => {
    vi.mocked(chat).mockResolvedValue(Array(30).fill("خط تکراری").join("\n"));
    const pdf = fakePdf([imagePage(1)]);

    const result = await extractPages(pdf);

    expect(result.ocrPages).toBe(0);
    expect(result.pages[0]!.method).toBe("text");
  });

  it("reads every poor page when no cap is set", async () => {
    const pages = Array.from({ length: 35 }, (_, i) => imagePage(i + 1));

    const result = await extractPages(fakePdf(pages));

    expect(chat).toHaveBeenCalledTimes(35);
    expect(result.ocrPages).toBe(35);
  });

  it("stops at a configured page cap and reports skipped pages", async () => {
    ocrSettings.maxPages = 30;
    const pages = Array.from({ length: 35 }, (_, i) => imagePage(i + 1));
    const progress = vi.fn();

    const result = await extractPages(fakePdf(pages), progress);

    expect(chat).toHaveBeenCalledTimes(30);
    expect(result.ocrPages).toBe(30);
    expect(progress).toHaveBeenNthCalledWith(1, { ocrTotal: 30, ocrDone: 0, skipped: 5 });
  });

  it("reports about every 10% for big documents", async () => {
    const pages = Array.from({ length: 100 }, (_, i) => imagePage(i + 1));
    const progress = vi.fn();

    await extractPages(fakePdf(pages), progress);

    expect(progress.mock.calls.map(([p]) => p.ocrDone)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
    ]);
  });

  it("reports progress every 5 pages", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => imagePage(i + 1));
    const progress = vi.fn();

    await extractPages(fakePdf(pages), progress);

    expect(progress.mock.calls.map(([p]) => p.ocrDone)).toEqual([0, 5, 10]);
  });
});

describe("cleanOcrText (repair of reversed words)", () => {
  beforeEach(() => vi.spyOn(logger, "info").mockImplementation(() => {}));

  it("both: a page written fully reversed is flipped back", () => {
    expect(cleanOcrText("تسا نیا رد هب زا کی متسیس", 1, "both")).toBe("است این در به از یک سیستم");
  });

  it("both: on a mostly correct page only the reversed words are fixed", () => {
    expect(cleanOcrText("کی سیستم خبره یارب حل مسائل هب کار میرود", 1, "both")).toBe(
      "یک سیستم خبره برای حل مسائل به کار میرود",
    );
  });

  it("page: a mostly correct page is left as it is (what the word repair adds)", () => {
    expect(cleanOcrText("کی سیستم خبره یارب حل مسائل", 1, "page")).toBe("کی سیستم خبره یارب حل مسائل");
  });
});
