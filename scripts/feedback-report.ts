/**
 * Real-usage report from the answer logs: how often users are happy, how fast
 * answers are, the live numbers per week, and every 👎 answer with what the
 * bot did. 👎 answers are also written out as draft eval cases (git-ignored,
 * they hold students' own words):
 * - eval/feedback-candidates.json: answers from the notes. Fill in
 *   expectedPages (the page that really has the answer) and move good ones
 *   into eval/questions.json.
 * - eval/feedback-router-candidates.json: answers given as general chat. If
 *   the message was about the student's notes, label it and move it into
 *   eval/router.json.
 * That turns real failures into regression tests.
 *
 * The weekly table (weeks start on Saturday) is what to watch between
 * releases: the share of answers given as chat, the share of document
 * questions the rewrite step changed, how often the bot said the notes don't
 * cover the question, answer time, and the 👍 share. A chat answer is logged
 * the same way whether the router chose chat or the student had no document
 * yet, so the chat share counts both.
 *
 *   npm run feedback
 *   npm run feedback -- --days 7
 */
import { writeFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";
import type { LoggedChunk } from "../src/db/answerLogs.js";
import { byWeek, percentile, usageStats } from "./usageStats.js";

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
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const share = (part: number, whole: number) =>
  whole === 0 ? "-" : `${part}/${whole} (${Math.round((part / whole) * 100)}%)`;

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

// --- Live numbers, per week and for the whole period -----------------------------

const statsRow = (group: Row[]) => {
  const stats = usageStats(group);

  return {
    answers: stats.answers,
    "chat route": share(stats.chat, stats.answers),
    "rewritten (of document)": share(stats.rewritten, stats.document),
    "refused (of document)": share(stats.refused, stats.document),
    median: seconds(stats.medianMs),
    p95: seconds(stats.p95Ms),
    "👍 of rated": share(stats.good, stats.good + stats.bad),
  };
};

if (rows.length > 0) {
  console.log("\nPer week (weeks start on Saturday):");
  console.table(
    Object.fromEntries([
      ...byWeek(rows).map(([week, group]) => [week, statsRow(group)] as const),
      ["all", statsRow(rows)] as const,
    ]),
  );
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

// 👎 on a chat answer: maybe a question about the notes that was not searched.
const routerCandidates = disliked
  .filter((row) => row.route === "chat")
  .map((row) => ({
    id: `real-fb-${row.id}`,
    kind: "",
    message: row.question,
    route: "document",
    note:
      `Answered as general chat and disliked on ${row.created_at.toISOString().slice(0, 10)}. ` +
      `Keep it only if the student had a document then and the message is about it: set kind ` +
      `(and mode, or leave mode out), add the earlier messages as history, remove this note.`,
  }));

if (routerCandidates.length > 0) {
  await writeFile("eval/feedback-router-candidates.json", JSON.stringify(routerCandidates, null, 2) + "\n");
  console.log(`Wrote ${routerCandidates.length} draft router cases to eval/feedback-router-candidates.json`);
}

await pool.end();
