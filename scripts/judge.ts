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
 * Calibration (npm run eval:citations -- --judge, 2026-11-13): 24/30 right
 * (80%), mismatched rejected 8/8, unsupported caught 4/6, supported accepted
 * 12/16 (two of the misses had garbled OCR sources), 25 s per pair. Below the
 * bar (85%, 5/6), so eval:answers does not use it; faithfulness stays
 * unmeasured. Re-run the calibration when trying another judge model.
 */
import { config } from "../src/config.js";

export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "gpt-oss:20b";
const JUDGE_NUM_GPU = Number(process.env.EVAL_JUDGE_NUM_GPU ?? 0);
const JUDGE_TIMEOUT_MS = 600_000;
/** Source text per claim; a page of notes is rarely longer. */
const MAX_SOURCE_CHARS = 4000;

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
Answer with JSON only: one verdict per claim, in order, with a short reason in English.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "integer" },
          supported: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["claim", "supported", "reason"],
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

/** Frees the GPU for the judge: unloads the answer model (Ollama reloads it on the next bot request). */
export async function unloadAnswerModel(): Promise<void> {
  await post({ model: config.llm.model, messages: [], keep_alive: 0 }, 60_000);
}

/** One verdict per claim, from a single judge call. */
export async function judgeClaims(claims: Claim[]): Promise<Verdict[]> {
  if (claims.length === 0) return [];

  const user = claims
    .map(
      (claim, index) =>
        `Claim ${index + 1}\nSentence: ${claim.sentence}\nSource:\n${claim.source.join("\n").slice(0, MAX_SOURCE_CHARS)}`,
    )
    .join("\n\n---\n\n");

  const data = (await post(
    {
      model: JUDGE_MODEL,
      stream: false,
      think: "low",
      format: SCHEMA,
      keep_alive: "10m",
      options: { temperature: 0, num_ctx: 16384, num_gpu: JUDGE_NUM_GPU },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    },
    JUDGE_TIMEOUT_MS,
  )) as { message?: { content?: string } };

  const parsed = JSON.parse(data.message?.content ?? "") as {
    verdicts?: { claim: number; supported: boolean; reason: string }[];
  };
  const byClaim = new Map((parsed.verdicts ?? []).map((verdict) => [verdict.claim, verdict]));

  return claims.map((_, index) => {
    const verdict = byClaim.get(index + 1);
    if (!verdict) throw new Error(`The judge gave no verdict for claim ${index + 1}`);
    return { supported: verdict.supported, reason: verdict.reason };
  });
}
