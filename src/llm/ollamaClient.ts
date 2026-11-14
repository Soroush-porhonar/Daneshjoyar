import { config } from "../config.js";
import { OllamaError, OllamaTimeoutError } from "../errors.js";
import { logger } from "../logger.js";
import { onGpu, pauseGpu } from "./scheduler.js";
import { recordFailure } from "../alerts.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64-encoded images for vision models. */
  images?: string[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  /** JSON schema for structured output. */
  format?: Record<string, unknown>;
  /** Ollama model options such as num_predict. */
  options?: Record<string, unknown>;
  /** Pass false to disable thinking on reasoning models. */
  think?: boolean;
  /** Called with the request's token counts and timings once the answer is complete. */
  onStats?: ((stats: ChatStats) => void) | undefined;
  /** Streams the answer: called with the whole text so far as it grows. */
  onDelta?: ((text: string) => void) | undefined;
}

/** What Ollama reports about one chat request (its own counters; times in milliseconds). */
export interface ChatStats {
  promptTokens: number;
  outputTokens: number;
  /** Loading the model into memory; near zero when it was already loaded. */
  loadMs: number;
  /** Reading the prompt. */
  promptEvalMs: number;
  /** Writing the answer. */
  evalMs: number;
  totalMs: number;
  /** "stop", or "length" when num_predict cut the answer short. */
  doneReason?: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  /** Durations are in nanoseconds. */
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

const nanosToMs = (nanos: number | undefined) => (nanos ?? 0) / 1e6;

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Ollama's words when the GPU or its runner crashed (seen with the Vulkan backend on this machine). */
const GPU_CRASH = /device lost|ErrorDeviceLost|vk::|vulkan|runner has unexpectedly stopped|runner process has terminated/i;

export const isGpuCrash = (error: unknown): boolean =>
  error instanceof OllamaError && !(error instanceof OllamaTimeoutError) && GPU_CRASH.test(error.message);

/** A timeout becomes OllamaTimeoutError; user cancellation and network errors pass through. */
function rethrow(error: unknown, label: string): never {
  if (error instanceof Error && error.name === "TimeoutError") {
    throw new OllamaTimeoutError(`Ollama ${label} request timed out.`);
  }
  throw error;
}

async function send(url: string, body: unknown, signal: AbortSignal, label: string): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    rethrow(error, label);
  }

  if (!response.ok) {
    // The body says why (a crashed runner, a lost GPU device): kept for the logs and isGpuCrash.
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new OllamaError(
      `Ollama ${label} error: ${response.status} ${response.statusText}${detail ? ` ${detail}` : ""}`,
    );
  }

  return response;
}

async function post<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  const response = await send(url, body, signal, label);

  try {
    return (await response.json()) as T;
  } catch {
    throw new OllamaError(`Ollama returned an invalid ${label} response.`);
  }
}

/**
 * A streamed chat (one JSON object per line), assembled into the response a
 * non-streamed request returns: the content joined, the counters from the
 * last line. `onDelta` gets the whole text so far after each piece.
 */
async function postStreamed(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<OllamaChatResponse> {
  const response = await send(url, { ...body, stream: true }, signal, "chat");
  if (!response.body) throw new OllamaError("Ollama returned an empty chat stream.");

  let content = "";
  let last: OllamaChatResponse = {};
  let buffered = "";
  const decoder = new TextDecoder();

  const read = (line: string) => {
    let part: OllamaChatResponse & { error?: string };
    try {
      part = JSON.parse(line) as OllamaChatResponse & { error?: string };
    } catch {
      throw new OllamaError("Ollama returned an invalid chat stream.");
    }
    if (part.error) throw new OllamaError(`Ollama chat error: ${part.error}`);
    last = part;
    const piece = part.message?.content ?? "";
    if (piece) {
      content += piece;
      onDelta(content);
    }
  };

  try {
    for await (const bytes of response.body) {
      buffered += decoder.decode(bytes as Uint8Array, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) if (line.trim()) read(line);
    }
  } catch (error: unknown) {
    if (error instanceof OllamaError) throw error;
    rethrow(error, "chat");
  }
  if (buffered.trim()) read(buffered);

  return { ...last, message: { content } };
}

/**
 * Sends a chat request and returns the trimmed, non-empty answer. With
 * `onDelta` the answer is streamed and `onDelta` sees the text as it grows.
 * The call waits its turn on the GPU queue (scheduler.ts); its timeout starts
 * when its turn comes, so waiting behind other students is not a timeout.
 */
export async function chat(request: ChatRequest): Promise<string> {
  const body = {
    model: config.llm.model,
    stream: false,
    keep_alive: config.llm.keepAlive,
    messages: request.messages,
    ...(request.think !== undefined ? { think: request.think } : {}),
    ...(request.format ? { format: request.format } : {}),
    options: { num_ctx: config.llm.numCtx, ...request.options },
  };
  const run = () =>
    onGpu((preempted) => {
      const signal = withTimeout(
        request.timeoutMs ?? config.llm.timeoutMs,
        request.signal ? AbortSignal.any([request.signal, preempted]) : preempted,
      );
      return request.onDelta
        ? postStreamed(config.llm.url, body, signal, request.onDelta)
        : post<OllamaChatResponse>(config.llm.url, body, signal, "chat");
    }, request.signal);

  let data: OllamaChatResponse;
  try {
    data = await run();
  } catch (error: unknown) {
    if (!(error instanceof OllamaError)) throw error; // a cancellation or a network error
    recordFailure(isGpuCrash(error) ? "gpu" : "ollama");
    if (!isGpuCrash(error)) throw error;
    // The Vulkan driver loses the device now and then: give it time, then try once more (roadmap 8.11).
    logger.error("[LLM] GPU crash pattern; pausing the queue and retrying once", { error: error.message });
    pauseGpu(config.alerts.gpuPauseMs);
    data = await run();
  }

  logger.debug("[LLM] chat finished", {
    doneReason: data.done_reason,
    promptTokens: data.prompt_eval_count,
    tokens: data.eval_count,
  });

  request.onStats?.({
    promptTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    loadMs: nanosToMs(data.load_duration),
    promptEvalMs: nanosToMs(data.prompt_eval_duration),
    evalMs: nanosToMs(data.eval_duration),
    totalMs: nanosToMs(data.total_duration),
    ...(data.done_reason === undefined ? {} : { doneReason: data.done_reason }),
  });

  const numCtx = Number(request.options?.num_ctx ?? config.llm.numCtx);
  const used = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);

  if (used >= numCtx * 0.9) {
    logger.warn(
      `[LLM] Context nearly full (${used}/${numCtx} tokens); the prompt may be truncated`,
    );
  }

  const content = data.message?.content;

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new OllamaError("Ollama returned an empty or invalid answer.");
  }

  return content.trim();
}

/**
 * Loads the chat and embedding models into memory at startup (roadmap S6):
 * otherwise the first question after a restart waited ~10 s for the load.
 * A chat with no messages only loads the model, but it must carry the same
 * num_ctx as real requests: without it Ollama loaded the model with its
 * default context (262144, 16.8 GB, mostly on the CPU) and reloaded it for
 * the first question. An embed with no input loads nothing, so one word is
 * embedded. Failures are logged, never thrown: the first request loads anyway.
 */
export async function preloadModels(): Promise<void> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(config.llm.timeoutMs);
  const results = await Promise.allSettled([
    post(
      config.llm.url,
      { model: config.llm.model, messages: [], keep_alive: config.llm.keepAlive, options: { num_ctx: config.llm.numCtx } },
      timeout,
      "preload",
    ),
    post(config.embedding.url, { model: config.embedding.model, input: ["سلام"], keep_alive: config.llm.keepAlive }, timeout, "preload"),
  ]);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) logger.warn("[LLM] Preloading models failed:", { errors: failed.map((f) => String(f.reason)) });
  else logger.info("[LLM] Models loaded", { ms: Date.now() - started });
}

/** Embeds one or many texts; returns one vector per input, in order. */
export async function embed(input: string[]): Promise<number[][]> {
  const data = await post<OllamaEmbedResponse>(
    config.embedding.url,
    { model: config.embedding.model, input, keep_alive: config.llm.keepAlive },
    AbortSignal.timeout(config.embedding.timeoutMs),
    "embedding",
  );

  const embeddings = data.embeddings;

  if (!embeddings || embeddings.length !== input.length) {
    throw new OllamaError(
      `Invalid embedding response: expected ${input.length} vectors, received ${
        embeddings?.length ?? 0
      }`,
    );
  }

  for (const vector of embeddings) {
    if (
      vector.length !== config.embedding.dimensions ||
      !vector.every(Number.isFinite)
    ) {
      throw new OllamaError(
        `Invalid embedding: expected ${config.embedding.dimensions} finite values, received ${vector.length}`,
      );
    }
  }

  return embeddings;
}
