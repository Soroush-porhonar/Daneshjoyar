/**
 * Latency benchmark: times each stage of answering a question, so we know
 * where the waiting time goes before trying to make anything faster.
 *
 *   npm run benchmark
 *   npm run benchmark -- --limit 4
 *
 * Stages: router (LLM), rewrite (LLM, follow-ups only), retrieval
 * (embedding + SQL), generation (LLM answer = total - retrieval).
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pool } from "../src/db/pool.js";
import { answerFromDocuments } from "../src/rag/answer.js";
import { generateEmbedding } from "../src/rag/embeddings.js";
import { retrieveContext } from "../src/rag/retrieve.js";
import { rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";
import { routeMessage } from "../src/rag/router.js";

interface EvalQuestion {
  id: string;
  type: string;
  filename: string;
  mode: "focused" | "multi_part" | "broad";
  question: string;
  history?: HistoryMessage[];
}

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 8;

// A mix of question kinds; broad summaries are left out (minutes per run).
const questions = (
  JSON.parse(await readFile("eval/questions.json", "utf-8")) as EvalQuestion[]
)
  .filter((q) => q.mode !== "broad" && q.type !== "negative")
  .filter((_, index) => index % 4 === 0)
  .slice(0, limit);

const timings: Record<string, number[]> = {
  router: [],
  rewrite: [],
  embedding: [],
  retrieval: [],
  generation: [],
  total: [],
};

async function time<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  timings[stage]!.push(performance.now() - start);
  return result;
}

const documents = await pool.query<{ filename: string; id: number; user_id: number }>(
  `SELECT DISTINCT ON (filename) filename, id, user_id FROM documents
   WHERE status = 'completed' ORDER BY filename, id DESC`,
);
const byName = new Map(documents.rows.map((row) => [row.filename, row]));

// Warm-up: the first call loads the models into memory and is not typical.
await generateEmbedding("گرم کردن");
await routeMessage("سلام", [], []);

for (const q of questions) {
  const document = byName.get(q.filename);
  if (!document) continue;
  console.log(`... ${q.id}`);

  const totalStart = performance.now();
  await time("router", () => routeMessage(q.question, [q.filename], q.history ?? []));
  const question = q.history
    ? await time("rewrite", () => rewriteQuestion(q.question, q.history!))
    : q.question;
  await time("embedding", () => generateEmbedding(question));
  const mode = q.mode === "multi_part" ? "multi_part" : "focused";
  const retrievalStart = performance.now();
  await time("retrieval", () => retrieveContext(document.user_id, question, mode, { documentId: document.id }));
  const retrievalMs = performance.now() - retrievalStart;
  const answerStart = performance.now();
  await answerFromDocuments(document.user_id, question, q.mode, { documentId: document.id });
  // answerFromDocuments retrieves again; subtract that to get the LLM time.
  timings.generation!.push(performance.now() - answerStart - retrievalMs);
  timings.total!.push(performance.now() - totalStart - retrievalMs);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const meanTotal =
  timings.total!.reduce((sum, ms) => sum + ms, 0) / Math.max(timings.total!.length, 1);

console.table(
  Object.fromEntries(
    Object.entries(timings)
      .filter(([, values]) => values.length > 0)
      .map(([stage, values]) => {
        const mean = values.reduce((sum, ms) => sum + ms, 0) / values.length;
        return [
          stage,
          {
            runs: values.length,
            p50: seconds(percentile(values, 50)),
            p95: seconds(percentile(values, 95)),
            "share of total": stage === "total" ? "" : `${Math.round((mean / meanTotal) * 100)}%`,
          },
        ];
      }),
  ),
);
console.log("(retrieval includes its own embedding call)");

await pool.end();
