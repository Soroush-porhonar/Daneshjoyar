import { beforeEach, describe, expect, it, vi } from "vitest";

// Fakes for the database, Bale and every AI step, so only the flow is tested.
vi.mock("../src/bale.js", () => ({
  sendMessage: vi.fn(),
  removeButtons: vi.fn(),
  editMessageText: vi.fn(),
}));
vi.mock("../src/db/users.js", () => ({ findOrCreateUser: vi.fn() }));
vi.mock("../src/db/conversations.js", () => ({
  findOrCreateConversation: vi.fn(),
  selectDocument: vi.fn(),
  getSelectedDocumentId: vi.fn(),
}));
vi.mock("../src/db/messages.js", () => ({
  saveMessage: vi.fn(),
  getRecentMessages: vi.fn(),
}));
vi.mock("../src/db/documents.js", () => ({
  listCompletedFilenames: vi.fn(),
  listDocuments: vi.fn(),
  findDocumentFilename: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock("../src/db/answerLogs.js", () => ({ createAnswerLog: vi.fn(), getLastAnswerHits: vi.fn() }));
vi.mock("../src/llm/generalChat.js", () => ({ askAI: vi.fn() }));
vi.mock("../src/rag/answer.js", () => ({
  answerFromDocuments: vi.fn(),
  prefetchCandidates: vi.fn(),
}));
// Keep the real rule that recognises questions about a document itself; fake the answer.
vi.mock("../src/rag/documentInfo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/documentInfo.js")>()),
  answerDocumentInfo: vi.fn(),
}));
// Keep the real rule for "shorter" / "in three sentences"; fake the answer.
vi.mock("../src/rag/transform.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/transform.js")>()),
  answerTransform: vi.fn(),
}));
// Keep the real needsRewrite (which messages count as follow-ups); fake the LLM call.
vi.mock("../src/rag/rewrite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/rewrite.js")>()),
  rewriteQuestion: vi.fn(),
}));
// Keep the real resolveRoute (when the notes overrule the router); fake the LLM call.
vi.mock("../src/rag/router.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rag/router.js")>()),
  routeMessage: vi.fn(),
}));

const { handleMessage } = await import("../src/chat/chatService.js");
const { editMessageText, removeButtons, sendMessage } = await import("../src/bale.js");
const { findOrCreateUser } = await import("../src/db/users.js");
const { findOrCreateConversation } = await import("../src/db/conversations.js");
const { saveMessage, getRecentMessages } = await import("../src/db/messages.js");
const { listCompletedFilenames } = await import("../src/db/documents.js");
const { askAI } = await import("../src/llm/generalChat.js");
const { answerFromDocuments, prefetchCandidates } = await import("../src/rag/answer.js");
const { createAnswerLog, getLastAnswerHits } = await import("../src/db/answerLogs.js");
const { answerDocumentInfo } = await import("../src/rag/documentInfo.js");
const { answerTransform } = await import("../src/rag/transform.js");
const { needsRewrite, rewriteQuestion } = await import("../src/rag/rewrite.js");
const { routeMessage } = await import("../src/rag/router.js");
const { logger } = await import("../src/logger.js");
const messages = await import("../src/messages.js");

const CHAT_ID = 42;
const USER_ID = 3;

const earlier = [
  { role: "user" as const, content: "پریم چیه؟" },
  { role: "assistant" as const, content: "یک الگوریتم درخت پوشا." },
];
const current = { role: "user" as const, content: "مرتبه‌اش چنده؟" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "info").mockImplementation(() => {});

  vi.mocked(findOrCreateUser).mockResolvedValue({ id: USER_ID } as never);
  vi.mocked(findOrCreateConversation).mockResolvedValue(11);
  // The current message is saved first, so it is the last history entry.
  vi.mocked(getRecentMessages).mockResolvedValue([...earlier, current]);
  vi.mocked(listCompletedFilenames).mockResolvedValue(["Algorithm.pdf"]);
  // Like the real one: only follow-ups are rewritten.
  vi.mocked(rewriteQuestion).mockImplementation(async (text, previous) =>
    needsRewrite(text, previous) ? `بازنویسی: ${text}` : text,
  );
  vi.mocked(answerFromDocuments).mockResolvedValue("جواب از جزوه");
  vi.mocked(askAI).mockResolvedValue("جواب عمومی");
  vi.mocked(createAnswerLog).mockResolvedValue(77);
});

/** The final reply (the last message sent to the user). */
const lastReply = () => vi.mocked(sendMessage).mock.calls.at(-1)?.[1];

describe("handleMessage", () => {
  it("answers a follow-up with the rewritten question, reranking the previous answer's hits too", async () => {
    const previousHits = [
      { documentId: 5, chunkIndex: 12 },
      { documentId: 6, chunkIndex: 3 },
    ];
    const search = Promise.resolve({ question: `بازنویسی: ${current.content}`, ranked: [] });
    vi.mocked(getLastAnswerHits).mockResolvedValue(previousHits);
    vi.mocked(prefetchCandidates).mockReturnValue(search);
    vi.mocked(routeMessage).mockResolvedValue({ route: "document", retrievalMode: "focused" });

    await expect(handleMessage(CHAT_ID, current.content)).resolves.toBe(true);

    // The router gave no follow-up decision, so the length rule decides (fallback).
    expect(rewriteQuestion).toHaveBeenCalledWith(current.content, earlier, undefined, true);
    // The text as typed is searched early; the answer uses the rewritten search.
    expect(prefetchCandidates).toHaveBeenCalledTimes(2);
    expect(prefetchCandidates).toHaveBeenNthCalledWith(1, USER_ID, current.content);
    expect(prefetchCandidates).toHaveBeenNthCalledWith(2, USER_ID, `بازنویسی: ${current.content}`, previousHits);
    expect(answerFromDocuments).toHaveBeenCalledWith(
      USER_ID,
      `بازنویسی: ${current.content}`,
      "focused",
      expect.objectContaining({ prefetch: search }),
    );
    expect(saveMessage).toHaveBeenLastCalledWith(11, "assistant", "جواب از جزوه");
    expect(lastReply()).toBe("جواب از جزوه");
  });

  it("uses the router's standalone question for a follow-up, without the rewrite call", async () => {
    vi.mocked(getLastAnswerHits).mockResolvedValue([]);
    vi.mocked(routeMessage).mockResolvedValue({
      route: "document",
      retrievalMode: "focused",
      dependsOnHistory: true,
      standaloneQuestion: "مرتبه اجرایی الگوریتم پریم چیست؟",
    });

    await expect(handleMessage(CHAT_ID, current.content)).resolves.toBe(true);

    expect(rewriteQuestion).not.toHaveBeenCalled();
    expect(prefetchCandidates).toHaveBeenLastCalledWith(USER_ID, "مرتبه اجرایی الگوریتم پریم چیست؟", []);
    expect(answerFromDocuments).toHaveBeenCalledWith(USER_ID, "مرتبه اجرایی الگوریتم پریم چیست؟", "focused", expect.anything());
  });

  it("falls back to the rewrite call when the router's standalone question is unusable", async () => {
    vi.mocked(getLastAnswerHits).mockResolvedValue([]);
    vi.mocked(routeMessage).mockResolvedValue({
      route: "document",
      retrievalMode: "focused",
      dependsOnHistory: true,
      standaloneQuestion: null,
    });

    await expect(handleMessage(CHAT_ID, current.content)).resolves.toBe(true);

    expect(rewriteQuestion).toHaveBeenCalledWith(current.content, earlier, undefined, true);
    expect(answerFromDocuments).toHaveBeenCalledWith(USER_ID, `بازنویسی: ${current.content}`, "focused", expect.anything());
  });

  it("searches a short standalone question after history as typed when the router says it stands alone", async () => {
    const early = Promise.resolve({ question: current.content, ranked: [] });
    vi.mocked(prefetchCandidates).mockReturnValue(early);
    vi.mocked(routeMessage).mockResolvedValue({
      route: "document",
      retrievalMode: "focused",
      dependsOnHistory: false,
      standaloneQuestion: null,
    });

    await expect(handleMessage(CHAT_ID, current.content)).resolves.toBe(true);

    expect(rewriteQuestion).not.toHaveBeenCalled();
    expect(prefetchCandidates).toHaveBeenCalledTimes(1);
    expect(answerFromDocuments).toHaveBeenCalledWith(
      USER_ID,
      current.content,
      "focused",
      expect.objectContaining({ prefetch: early }),
    );
  });

  it("answers a question about the document itself from its profile, and logs that route", async () => {
    const question = "نویسنده این جزوه کیه؟";
    vi.mocked(getRecentMessages).mockResolvedValue([{ role: "user", content: question }]);
    vi.mocked(answerDocumentInfo).mockResolvedValue("درباره جزوه");

    await expect(handleMessage(CHAT_ID, question)).resolves.toBe(true);

    expect(routeMessage).not.toHaveBeenCalled();

    expect(answerDocumentInfo).toHaveBeenCalledWith(USER_ID, question, expect.objectContaining({ trace: expect.anything() }));
    expect(answerFromDocuments).not.toHaveBeenCalled();
    expect(createAnswerLog).toHaveBeenCalledWith(
      expect.objectContaining({ route: "document_info", retrievalMode: null, answer: "درباره جزوه" }),
    );
    expect(lastReply()).toBe("درباره جزوه");
  });

  it("reshapes the previous answer from its sources for 'shorter', without the router or a search", async () => {
    const request = { role: "user" as const, content: "کوتاه‌ترش کن" };
    const hits = [{ documentId: 5, chunkIndex: 12 }];
    vi.mocked(getRecentMessages).mockResolvedValue([...earlier, request]);
    vi.mocked(getLastAnswerHits).mockResolvedValue(hits);
    vi.mocked(answerTransform).mockResolvedValue("کوتاه‌تر [1]");

    await expect(handleMessage(CHAT_ID, request.content)).resolves.toBe(true);

    expect(answerTransform).toHaveBeenCalledWith(USER_ID, "کوتاه‌ترش کن", earlier[1]!.content, hits, expect.anything());
    expect(routeMessage).not.toHaveBeenCalled();
    expect(prefetchCandidates).not.toHaveBeenCalled();
    expect(createAnswerLog).toHaveBeenCalledWith(expect.objectContaining({ route: "transform" }));
    expect(lastReply()).toBe("کوتاه‌تر [1]");
  });

  it("treats 'shorter' as a normal message when the previous answer was not from the notes", async () => {
    const request = { role: "user" as const, content: "کوتاه‌ترش کن" };
    vi.mocked(getRecentMessages).mockResolvedValue([...earlier, request]);
    vi.mocked(getLastAnswerHits).mockResolvedValue([]);
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await expect(handleMessage(CHAT_ID, request.content)).resolves.toBe(true);

    expect(answerTransform).not.toHaveBeenCalled();
    expect(routeMessage).toHaveBeenCalled();
  });

  it("still answers a follow-up when the previous answer cannot be read", async () => {
    vi.mocked(getLastAnswerHits).mockRejectedValue(new Error("db down"));
    vi.mocked(routeMessage).mockResolvedValue({ route: "document", retrievalMode: "focused" });

    await expect(handleMessage(CHAT_ID, current.content)).resolves.toBe(true);

    expect(prefetchCandidates).toHaveBeenCalledWith(USER_ID, `بازنویسی: ${current.content}`, null);
    expect(lastReply()).toBe("جواب از جزوه");
  });

  it("starts searching a standalone question while the router decides", async () => {
    const question = "الگوریتم پریم چطور درخت پوشای کمینه را پیدا می‌کند و مرتبه اجرایی آن چیست؟";
    const early = Promise.resolve({ question, ranked: [] });
    vi.mocked(prefetchCandidates).mockReturnValue(early);
    vi.mocked(routeMessage).mockResolvedValue({ route: "document", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, question);

    expect(prefetchCandidates).toHaveBeenCalledWith(USER_ID, question);
    expect(answerFromDocuments).toHaveBeenCalledWith(
      USER_ID,
      question,
      "focused",
      expect.objectContaining({ prefetch: early }),
    );
  });

  it("logs a document answer and attaches 👍/👎 buttons to it", async () => {
    vi.mocked(routeMessage).mockResolvedValue({ route: "document", retrievalMode: "focused" });
    vi.mocked(answerFromDocuments).mockImplementation(
      async (_user, _q, _mode, options) => {
        const trace = options!.trace!;
        trace.documentIds = [5];
        trace.context = [
          { documentId: 5, filename: "a.pdf", pageNumber: 14, chunkIndex: 13, content: "x", isHit: true },
        ];
        return "جواب از جزوه";
      },
    );

    await handleMessage(CHAT_ID, current.content);

    expect(createAnswerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        question: current.content,
        rewrittenQuestion: `بازنویسی: ${current.content}`,
        route: "document",
        retrievalMode: "focused",
        documentIds: [5],
        context: [{ documentId: 5, page: 14, pageEnd: null, chunkIndex: 13, isHit: true }],
        answer: "جواب از جزوه",
        latencyMs: expect.any(Number),
      }),
    );
    expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[2]).toEqual({
      inline: [
        [
          expect.objectContaining({ callback_data: "fb:77:1" }),
          expect.objectContaining({ callback_data: "fb:77:-1" }),
        ],
      ],
    });
  });

  it("answers from the notes when the router says chat but the early search clearly matched", async () => {
    const question = "سیستم خبره چیست و چه خصوصیاتی دارد؟ لطفاً کامل و دقیق توضیح بده";
    const early = Promise.resolve({
      question,
      ranked: [{ documentId: 58, filename: "CamScanner.pdf", pageNumber: 1, chunkIndex: 0, content: "x", distance: 0.3, rerankScore: 6 }],
    });
    vi.mocked(prefetchCandidates).mockReturnValue(early);
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, question);

    expect(askAI).not.toHaveBeenCalled();
    expect(answerFromDocuments).toHaveBeenCalledWith(
      USER_ID,
      question,
      "focused",
      expect.objectContaining({ prefetch: early }),
    );
  });

  it("keeps general chat when the early search found nothing that clearly matches", async () => {
    const question = "به نظرت کدوم تیم قهرمان جام جهانی میشه؟ دوست دارم نظرت رو بدونم";
    vi.mocked(prefetchCandidates).mockReturnValue(
      Promise.resolve({
        question,
        ranked: [{ documentId: 58, filename: "CamScanner.pdf", pageNumber: 1, chunkIndex: 0, content: "x", distance: 0.5, rerankScore: -8 }],
      }),
    );
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, question);

    expect(askAI).toHaveBeenCalled();
    expect(answerFromDocuments).not.toHaveBeenCalled();
  });

  it("logs chat answers too", async () => {
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, "یه جوک بگو");

    expect(createAnswerLog).toHaveBeenCalledWith(
      expect.objectContaining({ route: "chat", question: "یه جوک بگو", context: [] }),
    );
  });

  it("does not log commands; a command's own buttons are sent (here: the main menu)", async () => {
    await handleMessage(CHAT_ID, "/help");

    expect(createAnswerLog).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[2]).toEqual({ keyboard: messages.MAIN_MENU });
  });

  it("shows a cancel button while answering, then replaces the notice with a short 'done' line", async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce(901); // the thinking notice
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, "یه جوک بگو");

    const [, noticeText, noticeMarkup] = vi.mocked(sendMessage).mock.calls[0]!;
    expect(noticeText).toBe(messages.THINKING_NOTICE_TEXT);
    expect(noticeMarkup).toEqual({ inline: [[expect.objectContaining({ callback_data: "cancel" })]] });
    expect(editMessageText).toHaveBeenCalledWith(CHAT_ID, 901, messages.THINKING_DONE_TEXT);
  });

  it("only removes the cancel button when answering fails (the error message follows)", async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce(902);
    vi.mocked(routeMessage).mockRejectedValue(new Error("ollama down"));

    await handleMessage(CHAT_ID, "یه جوک بگو");

    expect(editMessageText).not.toHaveBeenCalled();
    expect(removeButtons).toHaveBeenCalledWith(CHAT_ID, 902);
    expect(lastReply()).toBe(messages.PROCESSING_FAILED_TEXT);
  });

  it("says 'cancelled' on the notice when the request was cancelled", async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce(903);
    const controller = new AbortController();
    vi.mocked(routeMessage).mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await handleMessage(CHAT_ID, "یه جوک بگو", controller.signal);

    expect(editMessageText).toHaveBeenCalledWith(CHAT_ID, 903, messages.REQUEST_CANCELLED_TEXT);
  });

  it("falls back to removing the button when the notice cannot be edited", async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce(904);
    vi.mocked(editMessageText).mockRejectedValueOnce(new Error("message not found"));
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, "یه جوک بگو");

    expect(removeButtons).toHaveBeenCalledWith(CHAT_ID, 904);
  });

  it("still sends the answer, without buttons, when logging fails", async () => {
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });
    vi.mocked(createAnswerLog).mockRejectedValue(new Error("db down"));
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(handleMessage(CHAT_ID, "یه جوک بگو")).resolves.toBe(true);

    expect(lastReply()).toBe("جواب عمومی");
    expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[2]).toBeUndefined();
  });

  it("ignores the early search when the message is chat", async () => {
    vi.mocked(prefetchCandidates).mockReturnValue(
      Promise.resolve({ question: "x", ranked: [] }),
    );
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, "سلام، امروز حال و هوای درس خوندن ندارم، چیکار کنم که انگیزه بگیرم؟");

    expect(answerFromDocuments).not.toHaveBeenCalled();
    expect(lastReply()).toBe("جواب عمومی");
  });

  it("gives the router the earlier messages without repeating the current one", async () => {
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, current.content);

    expect(routeMessage).toHaveBeenCalledWith(current.content, ["Algorithm.pdf"], earlier);
  });

  it("uses general chat when the router says chat", async () => {
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });

    await handleMessage(CHAT_ID, "یه جوک بگو");

    expect(askAI).toHaveBeenCalled();
    expect(answerFromDocuments).not.toHaveBeenCalled();
    expect(lastReply()).toBe("جواب عمومی");
  });

  it("skips the router when the user has no documents", async () => {
    vi.mocked(listCompletedFilenames).mockResolvedValue([]);

    await handleMessage(CHAT_ID, "یه جوک بگو");

    expect(routeMessage).not.toHaveBeenCalled();
    expect(askAI).toHaveBeenCalled();
  });

  it("runs commands without calling the AI", async () => {
    await handleMessage(CHAT_ID, "/help");

    expect(routeMessage).not.toHaveBeenCalled();
    expect(lastReply()).toBe(messages.HELP_TEXT);
  });

  it("tells the user when the message could not be saved", async () => {
    vi.mocked(saveMessage).mockRejectedValueOnce(new Error("db down"));

    await expect(handleMessage(CHAT_ID, "یه جوک بگو")).resolves.toBe(true);

    expect(lastReply()).toBe(messages.SAVE_MESSAGE_FAILED_TEXT);
    expect(routeMessage).not.toHaveBeenCalled();
  });

  it("tells the user when answering fails", async () => {
    vi.mocked(routeMessage).mockRejectedValue(new Error("ollama down"));

    await expect(handleMessage(CHAT_ID, "سؤال")).resolves.toBe(true);

    expect(lastReply()).toBe(messages.PROCESSING_FAILED_TEXT);
  });

  it("stays quiet when the user cancelled the request", async () => {
    const controller = new AbortController();
    vi.mocked(routeMessage).mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(handleMessage(CHAT_ID, "سؤال", controller.signal)).resolves.toBe(true);

    expect(lastReply()).toBe(messages.THINKING_NOTICE_TEXT);
  });

  it("asks for a retry when the answer cannot be delivered", async () => {
    vi.mocked(routeMessage).mockResolvedValue({ route: "chat", retrievalMode: "focused" });
    vi.mocked(sendMessage)
      .mockResolvedValueOnce(undefined) // thinking notice
      .mockRejectedValueOnce(new Error("bale down")); // the answer

    await expect(handleMessage(CHAT_ID, "یه جوک بگو")).resolves.toBe(false);
  });
});
