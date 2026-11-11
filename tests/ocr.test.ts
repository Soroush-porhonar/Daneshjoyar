import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageText, PdfHandle } from "../src/rag/pdf.js";

// The vision model is replaced by a fake that "reads" a page image.
vi.mock("../src/llm/ollamaClient.js", () => ({ chat: vi.fn() }));
// The rendered page goes to the model as it is, unless a test cuts it into strips.
vi.mock("../src/rag/pageImage.js", () => ({
  preparePageImages: vi.fn(async (png: Uint8Array) => [Buffer.from(png)]),
}));
// A copy of the OCR settings that tests may change (e.g. set a page cap).
vi.mock("../src/config.js", async (importOriginal) => {
  const { config } = await importOriginal<typeof import("../src/config.js")>();
  return { config: { ...config, ocr: { ...config.ocr } } };
});

const { config } = await import("../src/config.js");
const ocrSettings = config.ocr as { maxPages: number };
const { cleanOcrText, extractPages, readPageImage } = await import("../src/rag/ocr.js");
const { chat } = await import("../src/llm/ollamaClient.js");
const { preparePageImages } = await import("../src/rag/pageImage.js");
const { OCR_PROMPT_FA, OCR_STRIP_PROMPT_FA } = await import("../src/llm/prompts/ocr.js");
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

  it("reads a page cut into strips one strip at a time, in order, as one page", async () => {
    const strips = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
    vi.mocked(preparePageImages).mockResolvedValueOnce(strips);
    vi.mocked(chat)
      .mockResolvedValueOnce("خط اول صفحه")
      .mockResolvedValueOnce("خط دوم صفحه")
      .mockResolvedValueOnce("خط سوم صفحه");

    const result = await extractPages(fakePdf([imagePage(1)]));

    expect(chat).toHaveBeenCalledTimes(3);
    expect(vi.mocked(chat).mock.calls.map(([request]) => request.messages[0]!.images)).toEqual(
      strips.map((strip) => [strip.toString("base64")]),
    );
    expect(vi.mocked(chat).mock.calls[0]![0].messages[0]!.content).toBe(OCR_STRIP_PROMPT_FA);
    expect(result.pages[0]!.text).toBe("خط اول صفحه\nخط دوم صفحه\nخط سوم صفحه");
  });

  it("uses the whole-page prompt for a page read in one image", async () => {
    const read = await readPageImage(fakePdf([imagePage(1)]), 1);

    expect(read.strips).toBe(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chat).mock.calls[0]![0].messages[0]!.content).toBe(OCR_PROMPT_FA);
  });

  it("stops reading strips once the request is cancelled", async () => {
    const controller = new AbortController();
    vi.mocked(preparePageImages).mockResolvedValueOnce([Buffer.from([1]), Buffer.from([2])]);
    vi.mocked(chat).mockImplementation(async ({ signal }) => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      controller.abort();
      return "خط اول";
    });

    await expect(readPageImage(fakePdf([imagePage(1)]), 1, undefined, controller.signal)).rejects.toThrow("aborted");
    expect(chat).toHaveBeenCalledTimes(2);
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

  it("stores formulas the model wrote in LaTeX as plain text", () => {
    expect(cleanOcrText("MAPE : $\\frac{100}{N} \\sum |y_i|$ میانگین", 1, "both")).toBe("MAPE : 100/N Σ |yi| میانگین");
  });
});
