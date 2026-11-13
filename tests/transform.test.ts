import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/rag/retrieve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/retrieve.js")>()),
  getChunksByRef: vi.fn(),
}));
// Keep the real numbering and sources list; fake only the model call.
vi.mock("../src/rag/answer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/answer.js")>()),
  generate: vi.fn(),
}));

const { answerTransform, isTransformRequest, previousAnswerBody } = await import("../src/rag/transform.js");
const { getChunksByRef } = await import("../src/rag/retrieve.js");
const { generate } = await import("../src/rag/answer.js");
const { SOURCES_HEADING } = await import("../src/messages.js");

describe("isTransformRequest", () => {
  it.each([
    "کوتاه‌ترش کن",
    "ساده‌تر بگو، نفهمیدم",
    "میتونی یه خلاصه سه جمله ای بهم بدی؟",
    "در دو جمله بگو",
    "به زبان ساده توضیح بده",
    "به صورت لیست بنویس",
    "مختصرتر",
  ])("recognises %s", (text) => {
    expect(isTransformRequest(text)).toBe(true);
  });

  it.each([
    "کدوم ساده‌تره، پریم یا کروسکال؟",
    "یه مثال بزن",
    "بیشتر توضیح بده",
    "این فصل را خلاصه کن",
    "قاعده باز و بسته در مهندسی نرم‌افزار چیست و چرا در طراحی کلاس‌ها اهمیت دارد؟ ساده‌تر بگو",
    "LIFO چیست؟",
  ])("does not take %s for one", (text) => {
    expect(isTransformRequest(text)).toBe(false);
  });
});

describe("previousAnswerBody", () => {
  it("drops the sources list and the old citation numbers", () => {
    expect(previousAnswerBody(`پشته LIFO است [2]، صف FIFO [1، 3].\n\n${SOURCES_HEADING}\n- [2] notes.pdf — صفحه 4`)).toBe(
      "پشته LIFO است، صف FIFO.",
    );
  });
});

describe("answerTransform", () => {
  const sources = [{ documentId: 5, chunkIndex: 3 }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getChunksByRef).mockResolvedValue([
      { documentId: 5, filename: "notes.pdf", pageNumber: 4, chunkIndex: 3, content: "پشته LIFO است", isHit: true },
    ]);
  });

  it("rewrites the previous answer from its own sources and cites them", async () => {
    vi.mocked(generate).mockResolvedValue("پشته LIFO است [1].");
    const trace = {};

    const answer = await answerTransform(3, "کوتاه‌ترش کن", `پشته ساختاری LIFO است [2].\n\n${SOURCES_HEADING}\n- [2] x`, sources, {
      trace,
    });

    expect(getChunksByRef).toHaveBeenCalledWith(3, sources);
    const prompt = vi.mocked(generate).mock.calls[0]![1];
    expect(prompt).toContain("<پاسخ قبلی>\nپشته ساختاری LIFO است.\n</پاسخ قبلی>");
    expect(prompt.trim().endsWith("کوتاه‌ترش کن")).toBe(true);
    expect(answer).toMatch(/notes⁩ — صفحه 4/);
    expect(trace).toMatchObject({ documentIds: [5] });
  });
});
