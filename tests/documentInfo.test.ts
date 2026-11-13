import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/documents.js", () => ({ listCompletedDocuments: vi.fn(), getDocumentProfile: vi.fn() }));
vi.mock("../src/rag/retrieve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/retrieve.js")>()),
  getDocumentChunks: vi.fn(),
}));
// Keep the real numbering, sources list and document choice; fake only the model call.
vi.mock("../src/rag/answer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/answer.js")>()),
  generate: vi.fn(),
}));

const { answerDocumentInfo, isDocumentInfoQuestion } = await import("../src/rag/documentInfo.js");
const { getDocumentProfile, listCompletedDocuments } = await import("../src/db/documents.js");
const { getDocumentChunks } = await import("../src/rag/retrieve.js");
const { generate } = await import("../src/rag/answer.js");

const chunk = (page: number, chunkIndex: number, content: string) => ({
  documentId: 7,
  filename: "covid.pdf",
  pageNumber: page,
  chunkIndex,
  content,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCompletedDocuments).mockResolvedValue([{ id: 7, filename: "covid.pdf", title: "کرونا", topics: [] }]);
  vi.mocked(getDocumentProfile).mockResolvedValue({ title: "کرونا", summary: "متنی درباره ویروس کرونا", topics: ["ویروس"] });
  vi.mocked(getDocumentChunks).mockResolvedValue([
    chunk(1, 0, "نویسنده: دکتر رئیسی"),
    chunk(1, 1, "مقدمه"),
    chunk(2, 2, "فصل اول"),
    chunk(3, 3, "فصل دوم"),
  ]);
});

describe("isDocumentInfoQuestion", () => {
  it.each([
    "این جزوه راجع به چیه؟ یه اطلاعات کلی بهم بده لطفا...",
    "این جزوه مال کیست؟",
    "درباره چیه",
    "این فایل درباره چیه؟",
    "سرفصل‌های این جزوه چیا هستن؟",
    "نویسنده این متن کیست و چه تخصصی دارد؟",
    "نويسنده اين جزوه كيه؟", // Arabic letters
    "این pdf چه مباحثی داره؟",
  ])("recognises %s", (text) => {
    expect(isDocumentInfoQuestion(text)).toBe(true);
  });

  it.each([
    "این جزوه درباره هافمن چی می‌گه؟",
    "نویسنده درباره نقش رسانه‌ها در آمار مرگ‌ومیر چه می‌گوید؟",
    "در کدام نوع بازبینی، نویسنده خودش جلسه را هدایت می‌کند؟",
    "این فصل را خلاصه کن",
    "درباره پشته توضیح بده",
    "سیستم خبره چیست؟",
  ])("does not take a question about the content for one: %s", (text) => {
    expect(isDocumentInfoQuestion(text)).toBe(false);
  });
});

describe("answerDocumentInfo", () => {
  it("answers from the profile and the opening chunks, without citations", async () => {
    vi.mocked(generate).mockResolvedValue("نویسنده دکتر رئیسی است [1].");
    const trace = {};

    const answer = await answerDocumentInfo(3, "نویسنده این جزوه کیه؟", { trace });

    const prompt = vi.mocked(generate).mock.calls[0]![1];
    expect(prompt).toContain("خلاصه کل فایل: متنی درباره ویروس کرونا");
    expect(prompt).toContain("نویسنده: دکتر رئیسی");
    expect(prompt).not.toContain("فصل دوم"); // only the first three chunks
    expect(answer).toBe("📄 درباره «covid.pdf»:\n\nنویسنده دکتر رئیسی است.");
    expect(trace).toMatchObject({ documentIds: [7] });
  });

  it("says there is no document when the user has none", async () => {
    vi.mocked(listCompletedDocuments).mockResolvedValue([]);
    const { NO_DOCUMENT_CONTENT_TEXT } = await import("../src/messages.js");

    await expect(answerDocumentInfo(3, "این جزوه درباره چیه؟")).resolves.toBe(NO_DOCUMENT_CONTENT_TEXT);
    expect(generate).not.toHaveBeenCalled();
  });
});
