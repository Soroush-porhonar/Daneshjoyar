import { config } from "../config.js";
import { OllamaError, OllamaTimeoutError } from "../errors.js";
import { logger } from "../logger.js";

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

async function post<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new OllamaTimeoutError(`Ollama ${label} request timed out.`);
    }

    // Preserve user cancellation and network errors for the caller.
    throw error;
  }

  if (!response.ok) {
    throw new OllamaError(
      `Ollama ${label} error: ${response.status} ${response.statusText}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new OllamaError(`Ollama returned an invalid ${label} response.`);
  }
}

/** Sends a chat request and returns the trimmed, non-empty answer. */
export async function chat(request: ChatRequest): Promise<string> {
  const data = await post<OllamaChatResponse>(
    config.llm.url,
    {
      model: config.llm.model,
      stream: false,
      keep_alive: config.llm.keepAlive,
      messages: request.messages,
      ...(request.think !== undefined ? { think: request.think } : {}),
      ...(request.format ? { format: request.format } : {}),
      options: { num_ctx: config.llm.numCtx, ...request.options },
    },
    withTimeout(request.timeoutMs ?? config.llm.timeoutMs, request.signal),
    "chat",
  );

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
