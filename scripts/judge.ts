/**
 * Faithfulness judge for the evals: does the cited source state what the
 * sentence says? Runs a different, larger model than the one that wrote the
 * answers (self-judging marked a wrong refusal faithful and correct refusals
 * unfaithful, roadmap 3.2). Eval-only; the bot never calls it.
 *
 * The model is EVAL_JUDGE_MODEL (default gpt-oss:20b). It does not fit in the
 * GPU next to the answer model, so `unloadAnswerModel()` frees the GPU first
 * and judging runs as its own pass over a saved run (eval:answers --rescore
 * --judge), never in the middle of one.
 *
 * It runs on the CPU (EVAL_JUDGE_NUM_GPU, default 0): on this machine's AMD
 * GPU, Ollama's Vulkan backend turns gpt-oss's output into gibberish (empty
 * content through the chat API), while the CPU gives correct output at about
 * 10 tokens/s (checked 2026-11-13, Ollama 0.40.13).
 *
 * Calibration on the 30 labelled pairs (npm run eval:citations -- --judge,
 * 2026-11-13; bar: all mismatched rejected, 5/6 unsupported caught, 85% right):
 *   verdict only, thinking low      24/30, unsupported 4/6, 25 s per pair
 *   verdict only, thinking medium   25/30, unsupported 4/6, 42 s per pair
 *   missing facts listed first, low 26/30, unsupported 5/6, 33 s per pair (used)
 * The prompt was tuned on the same 30 pairs and passes by one pair, and it
 * rejects 3/16 supported claims: read its number as a rough, low estimate.
 * Re-run the calibration when changing the prompt or the model.
 */
import { config } from "../src/config.js";

export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "gpt-oss:20b";
const JUDGE_NUM_GPU = Number(process.env.EVAL_JUDGE_NUM_GPU ?? 0);
/** gpt-oss reasoning effort: low, medium or high. */
const JUDGE_THINK = process.env.EVAL_JUDGE_THINK ?? "low";
const JUDGE_TIMEOUT_MS = 600_000;
/** Source text per claim: a page of notes is rarely over 4000 characters, and a sentence may cite three. */
const MAX_SOURCE_CHARS = 12_000;

export interface Claim {
  sentence: string;
  /** The cited source's text (its chunks). */
  source: string[];
}

export interface Verdict {
  supported: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You check citations in answers written by a study assistant for Persian-speaking students.
For each numbered claim you get one sentence of an answer and the source text it cites.
Decide whether the source supports the sentence:
- supported = true when everything the sentence states can be found in the source, possibly in other words, summarised, or translated between Persian and English.
- supported = false when the sentence states something the source does not say, contradicts it, gets a name, number or relation wrong, or the source is about something else.
The source may come from OCR and contain broken letters or spacing; read through that noise, but a fact must still be there to count.
Judge only against the given source, not against your own knowledge.
Work fact by fact: split the sentence into its separate facts (each name, number, cause, effect, example or relation), look for each one in the source, and list in "missing" every fact the source does not contain, in English. A sentence that is only partly in the source is not supported.
Answer with JSON only: one verdict per claim, in order: the missing facts first, then supported (true only when nothing is missing), then a short reason in English.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "integer" },
          missing: { type: "array", items: { type: "string" } },
          supported: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["claim", "missing", "supported", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

function chatUrl(): string {
  return config.llm.url;
}

async function post(body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(chatUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  return response.json();
}

/**
 * A streamed chat call, returning the whole reply. Streaming keeps bytes
 * flowing: a non-streamed call on the CPU can take over five minutes, and
 * Node's fetch drops a response whose headers take that long ("fetch failed").
 */
async function chatStreamed(body: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const response = await fetch(chatUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);

  let content = "";
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines.filter((l) => l.trim())) {
      const part = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (part.error) throw new Error(`Ollama returned an error: ${part.error}`);
      content += part.message?.content ?? "";
    }
  }
  return content;
}

/**
 * Frees the GPU for the judge: unloads the answer model (Ollama reloads it on
 * the next bot request). Nothing to free when the judge runs on the CPU.
 */
export async function unloadAnswerModel(): Promise<void> {
  if (JUDGE_NUM_GPU === 0) return;
  await post({ model: config.llm.model, messages: [], keep_alive: 0 }, 60_000);
}

/**
 * One verdict per claim, one call per claim: the judge was calibrated on
 * single claims, and several claims in one call ran past five minutes on the CPU.
 */
export async function judgeClaims(claims: Claim[]): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const claim of claims) verdicts.push(...(await judgeInOneCall([claim])));
  return verdicts;
}

async function judgeInOneCall(claims: Claim[]): Promise<Verdict[]> {
  if (claims.length === 0) return [];

  const user = claims
    .map(
      (claim, index) =>
        `Claim ${index + 1}\nSentence: ${claim.sentence}\nSource:\n${claim.source.join("\n").slice(0, MAX_SOURCE_CHARS)}`,
    )
    .join("\n\n---\n\n");

  const call = (temperature: number) =>
    chatStreamed(
      {
        model: JUDGE_MODEL,
        think: JUDGE_THINK,
        format: SCHEMA,
        keep_alive: "10m",
        options: { temperature, num_ctx: 16384, num_gpu: JUDGE_NUM_GPU },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      },
      JUDGE_TIMEOUT_MS,
    );

  // At temperature 0 gpt-oss sometimes loops until Ollama aborts ("token repeat
  // limit reached"); one retry at a higher temperature gets out of the loop.
  const data = await call(0).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("repeat limit")) return call(0.7);
    throw error;
  });

  const parsed = JSON.parse(data) as {
    verdicts?: { claim: number; missing?: string[]; supported: boolean; reason: string }[];
  };
  const byClaim = new Map((parsed.verdicts ?? []).map((verdict) => [verdict.claim, verdict]));

  return claims.map((_, index) => {
    const verdict = byClaim.get(index + 1);
    if (!verdict) throw new Error(`The judge gave no verdict for claim ${index + 1}`);
    // A verdict that lists missing facts is not supported, whatever its flag says.
    const missing = verdict.missing ?? [];
    return {
      supported: verdict.supported && missing.length === 0,
      reason: missing.length > 0 ? `missing: ${missing.join("; ")}` : verdict.reason,
    };
  });
}
