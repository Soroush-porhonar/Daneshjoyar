import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat, embed, isGpuCrash, preloadModels } from "../src/llm/ollamaClient.js";
import { resetScheduler } from "../src/llm/scheduler.js";
import { OllamaError, OllamaTimeoutError } from "../src/errors.js";
import { logger } from "../src/logger.js";

// Fake "network": every test decides what Ollama answers.
const fetchMock = vi.fn();

const reply = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, statusText: "Status" }),
  );

/** The JSON body of the n-th request sent to Ollama. */
const sentBody = (call = 0) =>
  JSON.parse(fetchMock.mock.calls[call]![1].body as string) as Record<string, any>;

const messages = [{ role: "user" as const, content: "سلام" }];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat", () => {
  it("returns the trimmed answer", async () => {
    reply({ message: { content: "  جواب  " } });

    await expect(chat({ messages })).resolves.toBe("جواب");
  });

  it("always sends a context size (Ollama's 4096 default truncates prompts)", async () => {
    reply({ message: { content: "ok" } });

    await chat({ messages, options: { temperature: 0.2 } });

    expect(sentBody().options).toEqual({ num_ctx: 8192, temperature: 0.2 });
    expect(sentBody().stream).toBe(false);
  });

  it("asks Ollama to keep the model loaded (avoids a ~10 s reload after pauses)", async () => {
    reply({ message: { content: "ok" } });

    await chat({ messages });

    expect(sentBody().keep_alive).toBe("30m");
  });

  it("reports Ollama's token counts and timings (nanoseconds) in milliseconds", async () => {
    reply({
      message: { content: "جواب" },
      done_reason: "length",
      prompt_eval_count: 1200,
      eval_count: 300,
      total_duration: 9_500_000_000,
      load_duration: 20_000_000,
      prompt_eval_duration: 1_400_000_000,
      eval_duration: 8_000_000_000,
    });
    const onStats = vi.fn();

    await chat({ messages, onStats });

    expect(onStats).toHaveBeenCalledExactlyOnceWith({
      promptTokens: 1200,
      outputTokens: 300,
      loadMs: 20,
      promptEvalMs: 1400,
      evalMs: 8000,
      totalMs: 9500,
      doneReason: "length",
    });
    // The callback is not part of the request sent to Ollama.
    expect(sentBody()).not.toHaveProperty("onStats");
  });

  it("reports zeros for counters Ollama leaves out", async () => {
    reply({ message: { content: "ok" } });
    const onStats = vi.fn();

    await chat({ messages, onStats });

    expect(onStats).toHaveBeenCalledWith({
      promptTokens: 0,
      outputTokens: 0,
      loadMs: 0,
      promptEvalMs: 0,
      evalMs: 0,
      totalMs: 0,
    });
  });

  it("lets a caller override the context size", async () => {
    reply({ message: { content: "ok" } });

    await chat({ messages, options: { num_ctx: 2048 } });

    expect(sentBody().options.num_ctx).toBe(2048);
  });

  it("sends think and format only when given", async () => {
    reply({ message: { content: "ok" } });
    reply({ message: { content: "{}" } });

    await chat({ messages });
    await chat({ messages, think: false, format: { type: "object" } });

    expect(sentBody(0)).not.toHaveProperty("think");
    expect(sentBody(0)).not.toHaveProperty("format");
    expect(sentBody(1).think).toBe(false);
    expect(sentBody(1).format).toEqual({ type: "object" });
  });

  it("throws OllamaError on an HTTP error", async () => {
    reply({ error: "model not found" }, 404);

    await expect(chat({ messages })).rejects.toBeInstanceOf(OllamaError);
  });

  it("throws OllamaError on an empty answer", async () => {
    reply({ message: { content: "   " } });

    await expect(chat({ messages })).rejects.toThrow(/empty or invalid/);
  });

  it("throws OllamaError when the body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));

    await expect(chat({ messages })).rejects.toThrow(/invalid chat response/);
  });

  it("turns a timeout into OllamaTimeoutError", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

    await expect(chat({ messages })).rejects.toBeInstanceOf(OllamaTimeoutError);
  });

  it("passes a user cancellation through unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abort);

    await expect(chat({ messages })).rejects.toBe(abort);
  });

  it("warns when the context window is nearly full", async () => {
    reply({ message: { content: "ok" }, prompt_eval_count: 7800, eval_count: 100 });

    await chat({ messages });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Context nearly full"));
  });

  it("does not warn for normal prompts", async () => {
    reply({ message: { content: "ok" }, prompt_eval_count: 1000, eval_count: 100 });

    await chat({ messages });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("chat, GPU crash pattern", () => {
  it("pauses the queue, retries once, and returns the retry's answer", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response("{\"error\":\"vk::Queue::submit: ErrorDeviceLost\"}", { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "جواب" } })));
      vi.spyOn(logger, "error").mockImplementation(() => {});

      const answer = chat({ messages });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(answer).resolves.toBe("جواب");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      resetScheduler();
    }
  });

  it("does not retry other Ollama errors, and keeps the reason", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"model not found"}', { status: 404 }));

    await expect(chat({ messages })).rejects.toThrow("model not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recognises the crash messages", () => {
    expect(isGpuCrash(new OllamaError("Ollama chat error: 500 llama runner process has terminated: exit status 2"))).toBe(true);
    expect(isGpuCrash(new OllamaError("Ollama chat error: 500 model runner has unexpectedly stopped"))).toBe(true);
    expect(isGpuCrash(new OllamaTimeoutError("Ollama chat request timed out."))).toBe(false);
    expect(isGpuCrash(new Error("vulkan"))).toBe(false);
  });
});

describe("preloadModels", () => {
  it("loads the chat model with the real context size (else Ollama reloads it) and embeds one word", async () => {
    reply({});
    reply({ embeddings: [[0.1]] });

    await preloadModels();

    expect(sentBody(0)).toEqual({
      model: expect.any(String),
      messages: [],
      keep_alive: "30m",
      options: { num_ctx: 8192 },
    });
    expect(sentBody(1)).toEqual({ model: expect.any(String), input: ["سلام"], keep_alive: "30m" });
  });

  it("only logs a failure", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(preloadModels()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("[LLM] Preloading models failed:", expect.anything());
  });
});

describe("chat, streamed", () => {
  /** A streamed reply: one JSON object per line, cut into byte chunks at awkward places. */
  const stream = (lines: unknown[], chunkSize = 7) => {
    const bytes = new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += chunkSize) controller.enqueue(bytes.slice(at, at + chunkSize));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
  };

  it("streams the text as it grows and returns the whole answer", async () => {
    stream([
      { message: { content: "سلام" }, done: false },
      { message: { content: " دنیا" }, done: false },
      { message: { content: "" }, done: true, done_reason: "stop", eval_count: 2 },
    ]);
    const seen: string[] = [];

    await expect(chat({ messages, onDelta: (text) => seen.push(text) })).resolves.toBe("سلام دنیا");

    expect(sentBody().stream).toBe(true);
    expect(seen).toEqual(["سلام", "سلام دنیا"]);
  });

  it("reports the last line's counters", async () => {
    stream([
      { message: { content: "جواب" }, done: false },
      { message: { content: "" }, done: true, done_reason: "length", eval_count: 1000, prompt_eval_count: 50 },
    ]);
    const onStats = vi.fn();

    await chat({ messages, onDelta: () => undefined, onStats });

    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ doneReason: "length", outputTokens: 1000, promptTokens: 50 }),
    );
  });

  it("throws OllamaError for an error line", async () => {
    stream([{ message: { content: "نیمه" } }, { error: "model crashed" }]);

    await expect(chat({ messages, onDelta: () => undefined })).rejects.toThrow(OllamaError);
  });

  it("throws OllamaError for an empty answer", async () => {
    stream([{ message: { content: "  " }, done: true }]);

    await expect(chat({ messages, onDelta: () => undefined })).rejects.toThrow(OllamaError);
  });

  it("lets a cancellation through", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => {
      controller.abort();
      init.signal!.throwIfAborted();
    });

    await expect(chat({ messages, signal: controller.signal, onDelta: () => undefined })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("embed", () => {
  const vector = (size = 1024) => Array.from({ length: size }, () => 0.1);

  it("returns one vector per input", async () => {
    reply({ embeddings: [vector(), vector()] });

    await expect(embed(["a", "b"])).resolves.toHaveLength(2);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    reply({ embeddings: [vector()] });

    await expect(embed(["a", "b"])).rejects.toThrow(/expected 2 vectors/);
  });

  it("rejects vectors with the wrong size (e.g. a different embedding model)", async () => {
    reply({ embeddings: [vector(768)] });

    await expect(embed(["a"])).rejects.toThrow(/expected 1024/);
  });

  it("rejects vectors containing NaN", async () => {
    const broken = vector();
    broken[5] = Number.NaN;
    // JSON turns NaN into null, which is not a finite number either.
    reply({ embeddings: [broken] });

    await expect(embed(["a"])).rejects.toBeInstanceOf(OllamaError);
  });
});
