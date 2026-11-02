/**
 * Real-usage report from the answer logs: how often users are happy, how fast
 * answers are, and every 👎 answer with what the bot did. 👎 answers are also
 * written to eval/feedback-candidates.json as draft eval questions: fill in
 * expectedPages (the page that really has the answer) and move good ones into
 * eval/questions.json — that turns real failures into regression tests.
 *
 *   npm run feedback
 *   npm run feedback -- --days 7
 */
import { writeFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";
import type { LoggedChunk } from "../src/db/answerLogs.js";

const args = process.argv.slice(2);
const daysIndex = args.indexOf("--days");
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 30;

interface Row {
  id: number;
  question: string;
  rewritten_question: string | null;
  route: string;
  retrieval_mode: string | null;
  filename: string | null;
  context: LoggedChunk[];
  answer: string;
  latency_ms: number;
  feedback: number | null;
  created_at: Date;
}

const { rows } = await pool.query<Row>(
  `SELECT a.id, a.question, a.rewritten_question, a.route, a.retrieval_mode,
          (SELECT string_agg(d.filename, ', ') FROM documents d
           WHERE d.id = ANY(a.document_ids) OR d.id = a.document_id) AS filename,
          a.context, a.answer, a.latency_ms, a.feedback, a.created_at
   FROM answer_logs a
   WHERE a.created_at > NOW() - make_interval(days => $1)
   ORDER BY a.created_at DESC`,
  [days],
);

const count = (test: (row: Row) => boolean) => rows.filter(test).length;
const percentile = (values: number[], p: number) =>
  values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(p * (values.length - 1))]!;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const good = count((r) => r.feedback === 1);
const bad = count((r) => r.feedback === -1);
const rated = good + bad;

console.log(`Answers in the last ${days} days: ${rows.length}`);
console.log(
  `  document ${count((r) => r.route === "document")}, chat ${count((r) => r.route === "chat")}`,
);
console.log(
  `  feedback: 👍 ${good}  👎 ${bad}  none ${rows.length - rated}` +
    (rated > 0 ? `  → satisfaction ${Math.round((good / rated) * 100)}% of rated` : ""),
);
for (const route of ["document", "chat"]) {
  const latencies = rows.filter((r) => r.route === route).map((r) => r.latency_ms);
  if (latencies.length > 0) {
    console.log(`  ${route} answer time: median ${seconds(percentile(latencies, 0.5))}, p95 ${seconds(percentile(latencies, 0.95))}`);
  }
}

const disliked = rows.filter((r) => r.feedback === -1);
if (disliked.length > 0) console.log(`\n👎 answers (newest first):`);

for (const row of disliked) {
  const hits = row.context.filter((c) => c.isHit).map((c) => c.page).join(", ") || "-";
  console.log(`\n#${row.id}  ${row.created_at.toISOString().slice(0, 16)}  ${row.route}/${row.retrieval_mode ?? "-"}  ${seconds(row.latency_ms)}`);
  console.log(`  question:  ${row.question}`);
  if (row.rewritten_question) console.log(`  rewritten: ${row.rewritten_question}`);
  if (row.filename) console.log(`  document:  ${row.filename}, pages found: ${hits}`);
  console.log(`  answer:    ${row.answer.replace(/\s+/g, " ").slice(0, 160)}…`);
}

const candidates = disliked
  .filter((row) => row.route === "document" && row.filename)
  .map((row) => ({
    id: `fb-${row.id}`,
    type: "real",
    mode: row.retrieval_mode ?? "focused",
    question: row.rewritten_question ?? row.question,
    expectedPages: [],
    filename: row.filename,
    note: `From a 👎 on ${row.created_at.toISOString().slice(0, 10)}; the bot used pages ${row.context
      .filter((c) => c.isHit)
      .map((c) => c.page)
      .join(", ")}. Fill expectedPages with the page that really answers it.`,
  }));

if (candidates.length > 0) {
  await writeFile("eval/feedback-candidates.json", JSON.stringify(candidates, null, 2) + "\n");
  console.log(`\nWrote ${candidates.length} draft eval questions to eval/feedback-candidates.json`);
}

await pool.end();
