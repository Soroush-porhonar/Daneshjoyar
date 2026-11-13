/**
 * Latency benchmark: times each stage of answering a question, so we know
 * where the waiting time goes before trying to make anything faster.
 *
 *   npm run benchmark
 *   npm run benchmark -- --limit 4
 *   npm run benchmark -- --concurrency 5    # 5 students asking at the same moment
 *   npm run benchmark -- --no-save
 *
 * Stages: router (LLM), rewrite (LLM, messages after an earlier exchange),
 * retrieval (embedding + SQL + rerank), generation (LLM answer = total -
 * retrieval). Generation also reports the answer's output tokens and tokens
 * per second (from Ollama's own counters).
 *
 * Three samples of questions:
 *   standalone  - a question with no conversation before it
 *   follow-up   - eval follow-ups with their history (rewritten, like the bot)
 *   + history   - the standalone questions again, asked after a greeting: the
 *                 bot treats a short message after any exchange as a follow-up
 *                 and pays for a rewrite call, as in most real conversations
 *
 * "First text" is when the student first sees part of the answer: answers
 * are streamed (config.stream), and the first edit shows once the text has
 * minGrowthChars characters. With STREAM_MODE=off it is the total.
 *
 * --concurrency N sends N questions through the whole pipeline at once, the
 * way the bot does (router and early search together, then the answer), and
 * reports how long each waited and how many failed. Ollama serves one request
 * at a time, so this measures the queue.
 *
 * Runs are saved to eval/results/ (benchmark-*.json, concurrency-*.json) and
 * compared with the previous one.
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { OllamaError, OllamaTimeoutError } from "../src/errors.js";
import { answerFromDocuments, prefetchCandidates } from "../src/rag/answer.js";
import { liveText } from "../src/chat/streamEditor.js";
import { runAs, startQuestion } from "../src/llm/scheduler.js";
import type { JobContext } from "../src/llm/scheduler.js";
import type { AnswerTrace } from "../src/rag/answer.js";
import { generateEmbedding } from "../src/rag/embeddings.js";
import { retrieveContext } from "../src/rag/retrieve.js";
import { needsRewrite, rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";
import { routeMessage } from "../src/rag/router.js";
import { evalUser, previousResult, saveResult } from "./evalHelpers.js";
import { percentile } from "./usageStats.js";

interface EvalQuestion {
  id: string;
  type: string;
  filename: string;
  mode: "focused" | "multi_part" | "broad";
  question: string;
  history?: HistoryMessage[];
}

interface Sample {
  sample: "standalone" | "follow-up" | "+ history";
  /** In the question mix the benchmark has always used; its stage table stays comparable with older runs. */
  core: boolean;
  q: EvalQuestion;
  history: HistoryMessage[];
}

/** Per question: milliseconds per stage, and the answer call's token counts. */
interface Timing {
  id: string;
  sample: Sample["sample"];
  core: boolean;
  router: number;
  rewrite?: number;
  embedding: number;
  retrieval: number;
  generation: number;
  total: number;
  firstText: number;
  outputTokens?: number;
  promptTokens?: number;
  tokensPerSecond?: number;
}

const STAGES = ["router", "rewrite", "embedding", "retrieval", "generation", "total"] as const;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const limit = Number(flag("limit") ?? 8);
const concurrency = flag("concurrency") === undefined ? null : Number(flag("concurrency"));
const save = !args.includes("--no-save");

/** A greeting exchange: enough history for the bot to treat the next short message as a follow-up. */
const GREETING: HistoryMessage[] = [
  { role: "user", content: "سلام" },
  { role: "assistant", content: "سلام! 👋 چطور می‌تونم کمکت کنم؟" },
];

const all = JSON.parse(await readFile("eval/questions.json", "utf-8")) as EvalQuestion[];

// A mix of question kinds; broad summaries are left out (minutes per run).
const standalone = all
  .filter((q) => q.mode !== "broad" && q.type !== "negative")
  .filter((_, index) => index % 4 === 0)
  .slice(0, limit);
const followUps = all
  .filter((q) => q.type === "follow_up" && q.history && q.mode !== "broad" && !standalone.includes(q))
  .slice(0, Math.ceil(limit / 2));

const samples: Sample[] = [
  ...standalone.map((q) => ({
    sample: q.history ? ("follow-up" as const) : ("standalone" as const),
    core: true,
    q,
    history: q.history ?? [],
  })),
  ...followUps.map((q) => ({ sample: "follow-up" as const, core: false, q, history: q.history! })),
  ...standalone
    .filter((q) => !q.history && needsRewrite(q.question, GREETING))
    .slice(0, Math.ceil(limit / 2))
    .map((q) => ({ sample: "+ history" as const, core: false, q, history: GREETING })),
];

const evalUserId = await evalUser(process.argv.slice(2), all.map((q) => q.filename));
const documents = await pool.query<{ filename: string; id: number; user_id: number }>(
  `SELECT DISTINCT ON (filename) filename, id, user_id FROM documents
   WHERE status = 'completed' AND user_id = $1 ORDER BY filename, id DESC`,
  [evalUserId],
);
const byName = new Map(documents.rows.map((row) => [row.filename, row]));

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await work();
  return [result, performance.now() - start];
}

// Warm-up: the first call loads the models into memory and is not typical.
await generateEmbedding("گرم کردن");
await routeMessage("سلام", [], []);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const settings = { model: config.llm.model, numCtx: config.llm.numCtx, reranker: config.reranker.enabled };

// --- Concurrency: N questions at once, like N students ---------------------------

if (concurrency !== null) {
  const filenames = documents.rows.map((row) => row.filename);
  const batch = Array.from({ length: concurrency }, (_, index) => standalone[index % standalone.length]!).filter(
    (q) => byName.has(q.filename),
  );

  /**
   * The bot's own order of work for a message that is answered from the
   * notes, as a question on the GPU queue (scheduler.ts): returns the places
   * in line it was told and how long its calls waited.
   */
  async function answerLikeBot(q: EvalQuestion): Promise<{ places: number[]; waitedMs: number }> {
    const job: JobContext = { kind: "answer", onPosition: (place) => places.push(place) };
    const places: number[] = [];
    const finished = startQuestion();
    try {
      await runAs(job, () => answerQuestionLikeBot(q));
    } finally {
      finished();
    }
    return { places, waitedMs: job.waitedMs ?? 0 };
  }

  async function answerQuestionLikeBot(q: EvalQuestion): Promise<void> {
    const document = byName.get(q.filename)!;
    const history = q.history ?? [];
    const prefetch = prefetchCandidates(document.user_id, q.question);
    prefetch.catch(() => undefined);

    const routed = await routeMessage(q.question, filenames, history);
    const followUp = routed.dependsOnHistory ?? needsRewrite(q.question, history);
    const question = followUp
      ? (routed.standaloneQuestion ?? (await rewriteQuestion(q.question, history, undefined, true)))
      : q.question;
    const search = followUp ? prefetchCandidates(document.user_id, question) : prefetch;
    await answerFromDocuments(document.user_id, question, q.mode, search ? { prefetch: search } : {});
  }

  const failureKind = (error: unknown) =>
    error instanceof OllamaTimeoutError ? "timeout" : error instanceof OllamaError ? "ollama error" : "other error";

  console.log(`Sending ${batch.length} questions at once...`);
  const wallStart = performance.now();
  const results = await Promise.all(
    batch.map(async (q) => {
      const start = performance.now();
      try {
        const { places, waitedMs } = await answerLikeBot(q);
        // Told where it stands: it either waited under a second or was given a place.
        const told = waitedMs < 1000 || places.some((place) => place > 0);
        return { id: q.id, ms: performance.now() - start, failed: "", waitedMs, firstPlace: places[0] ?? 0, told };
      } catch (error: unknown) {
        return { id: q.id, ms: performance.now() - start, failed: failureKind(error), waitedMs: 0, firstPlace: 0, told: false };
      }
    }),
  );
  const wallMs = performance.now() - wallStart;

  console.table(
    results.map((r) => ({
      id: r.id,
      total: seconds(r.ms),
      "GPU queue wait": seconds(r.waitedMs),
      "first place told": r.firstPlace || "-",
      result: r.failed || "ok",
    })),
  );

  const done = results.filter((r) => !r.failed).map((r) => r.ms);
  const failures = results.filter((r) => r.failed);
  const kinds = [...new Set(failures.map((r) => r.failed))].map(
    (kind) => `${failures.filter((r) => r.failed === kind).length} ${kind}`,
  );
  const summary = {
    concurrency: batch.length,
    answered: done.length,
    failed: failures.length,
    p50Ms: Math.round(percentile(done, 0.5)),
    p95Ms: Math.round(percentile(done, 0.95)),
    maxMs: Math.round(Math.max(0, ...done)),
    wallMs: Math.round(wallMs),
    answersPerMinute: Number(((done.length / wallMs) * 60_000).toFixed(1)),
    toldPlace: results.filter((r) => r.told).length,
  };

  console.log(
    `${summary.answered}/${batch.length} answered` +
      (failures.length > 0 ? `, ${kinds.join(", ")}` : "") +
      `; wait p50 ${seconds(summary.p50Ms)}, p95 ${seconds(summary.p95Ms)}, longest ${seconds(summary.maxMs)}; ` +
      `${seconds(wallMs)} in all = ${summary.answersPerMinute} answers per minute ` +
      `(request timeout ${config.llm.timeoutMs / 1000} s, counted from the job's turn on the GPU); ` +
      `told their place or served at once: ${summary.toldPlace}/${batch.length}`,
  );

  const previous = await previousResult<{ summary: typeof summary }>("concurrency");
  if (previous) {
    const old = previous.data.summary;
    console.log(
      `Previous run (${previous.file}): ${old.answered}/${old.concurrency} answered, ` +
        `wait p50 ${seconds(old.p50Ms)}, p95 ${seconds(old.p95Ms)}, ${old.answersPerMinute} answers per minute`,
    );
  }

  if (save) console.log(`Saved ${await saveResult("concurrency", { settings, summary, results })}`);

  await pool.end();
  process.exit(0);
}

// --- One question at a time: where the time goes ---------------------------------

const timings: Timing[] = [];

for (const { sample, core, q, history } of samples) {
  const document = byName.get(q.filename);
  if (!document) continue;
  console.log(`... ${q.id} (${sample})`);

  const totalStart = performance.now();
  const [routed, router] = await timed(() => routeMessage(q.question, [q.filename], history));
  // Like the bot: the router decides and usually writes the standalone question
  // itself; the separate rewrite call runs only as its fallback.
  const followUp = routed.dependsOnHistory ?? needsRewrite(q.question, history);
  const [question, rewriteMs] =
    followUp && !routed.standaloneQuestion
      ? await timed(() => rewriteQuestion(q.question, history, undefined, true))
      : [followUp ? routed.standaloneQuestion! : q.question, undefined];
  const [, embedding] = await timed(() => generateEmbedding(question));
  const mode = q.mode === "multi_part" ? "multi_part" : "focused";
  const [, retrieval] = await timed(() => retrieveContext(document.user_id, question, mode, { documentId: document.id }));

  const trace: AnswerTrace = {};
  let firstTextAt: number | undefined;
  const onDelta = (text: string) => {
    if (firstTextAt === undefined && liveText(text).length >= config.stream.minGrowthChars) firstTextAt = performance.now();
  };
  const [, answerMs] = await timed(() =>
    answerFromDocuments(document.user_id, question, q.mode, {
      documentId: document.id,
      trace,
      ...(config.stream.mode === "off" ? {} : { onDelta }),
    }),
  );
  const totalMs = performance.now() - totalStart - retrieval;
  const llm = trace.generation;

  timings.push({
    id: q.id,
    sample,
    core,
    router,
    ...(rewriteMs === undefined ? {} : { rewrite: rewriteMs }),
    embedding,
    retrieval,
    // answerFromDocuments retrieves again; subtract that to get the LLM time.
    generation: answerMs - retrieval,
    total: totalMs,
    firstText: firstTextAt === undefined ? totalMs : firstTextAt - totalStart - retrieval,
    ...(llm
      ? {
          outputTokens: llm.outputTokens,
          promptTokens: llm.promptTokens,
          tokensPerSecond: llm.evalMs > 0 ? llm.outputTokens / (llm.evalMs / 1000) : 0,
        }
      : {}),
  });
}

const values = (group: Timing[], stage: (typeof STAGES)[number] | "firstText") =>
  group.map((timing) => timing[stage]).filter((value): value is number => value !== undefined);
const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / Math.max(list.length, 1);

/** p50 / p95 per stage of a group of questions. */
function stageTable(group: Timing[]) {
  const meanTotal = mean(values(group, "total"));

  return Object.fromEntries(
    STAGES.filter((stage) => values(group, stage).length > 0).map((stage) => {
      const list = values(group, stage);
      return [
        stage,
        {
          runs: list.length,
          p50: seconds(percentile(list, 0.5)),
          p95: seconds(percentile(list, 0.95)),
          "share of total": stage === "total" ? "" : `${Math.round(((mean(list) * list.length) / group.length / meanTotal) * 100)}%`,
        },
      ];
    }),
  );
}

const coreTimings = timings.filter((timing) => timing.core);

console.log(`\nStages, on the usual mix of ${coreTimings.length} questions (comparable with earlier runs):`);
console.table(stageTable(coreTimings));
console.log("(retrieval includes its own embedding call; shares are of the mean total per question)");

const summarize = (group: Timing[]) => {
  const tokens = group.map((timing) => timing.outputTokens).filter((value): value is number => value !== undefined);
  const speeds = group.map((timing) => timing.tokensPerSecond).filter((value): value is number => value !== undefined);

  return {
    questions: group.length,
    totalP50Ms: Math.round(percentile(values(group, "total"), 0.5)),
    totalP95Ms: Math.round(percentile(values(group, "total"), 0.95)),
    firstTextP50Ms: Math.round(percentile(values(group, "firstText"), 0.5)),
    rewriteP50Ms: Math.round(percentile(values(group, "rewrite"), 0.5)),
    generationP50Ms: Math.round(percentile(values(group, "generation"), 0.5)),
    outputTokensP50: Math.round(percentile(tokens, 0.5)),
    outputTokensP95: Math.round(percentile(tokens, 0.95)),
    tokensPerSecond: Number(mean(speeds).toFixed(1)),
  };
};

const bySample = Object.fromEntries(
  [...new Set(timings.map((timing) => timing.sample))].map((sample) => [
    sample,
    summarize(timings.filter((timing) => timing.sample === sample)),
  ]),
);

console.log("\nBy sample:");
console.table(
  Object.fromEntries(
    Object.entries(bySample).map(([sample, s]) => [
      sample,
      {
        questions: s.questions,
        "total p50": seconds(s.totalP50Ms),
        "total p95": seconds(s.totalP95Ms),
        "first text p50": seconds(s.firstTextP50Ms),
        "rewrite p50": s.rewriteP50Ms ? seconds(s.rewriteP50Ms) : "-",
        "generation p50": seconds(s.generationP50Ms),
        "output tokens p50 / p95": `${s.outputTokensP50} / ${s.outputTokensP95}`,
        "tokens/s": s.tokensPerSecond,
      },
    ]),
  ),
);
console.log(`(first text: answers streamed, STREAM_MODE=${config.stream.mode})`);

const stages = Object.fromEntries(
  STAGES.filter((stage) => values(coreTimings, stage).length > 0).map((stage) => [
    stage,
    {
      runs: values(coreTimings, stage).length,
      p50Ms: Math.round(percentile(values(coreTimings, stage), 0.5)),
      p95Ms: Math.round(percentile(values(coreTimings, stage), 0.95)),
    },
  ]),
);

const previous = await previousResult<{ stages: typeof stages }>("benchmark");

if (previous) {
  console.log(`\nCompared with ${previous.file} (p50 per stage):`);
  for (const [stage, now] of Object.entries(stages)) {
    const old = previous.data.stages[stage];
    if (!old) continue;
    const change = now.p50Ms - old.p50Ms;
    console.log(
      `  ${stage.padEnd(10)} ${seconds(old.p50Ms)} -> ${seconds(now.p50Ms)}  (${change >= 0 ? "+" : ""}${(change / 1000).toFixed(1)}s)`,
    );
  }
}

if (save) console.log(`\nSaved ${await saveResult("benchmark", { settings, limit, stages, bySample, timings })}`);

await pool.end();
