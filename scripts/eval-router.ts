/**
 * Router evaluation: sends labelled messages to the router and measures how
 * often it picks the right route (document/chat) and retrieval mode.
 *
 *   npm run eval:router
 *   npm run eval:router -- --only followup
 *   npm run eval:router -- --with-search            # + the notes overruling the router
 *   npm run eval:router -- --with-search --user 1   # whose documents to search
 *
 * --with-search also runs the early search (all of a user's documents, by
 * default the user with the most) and records each message's best reranker
 * score. The router sees only file names; when its "chat" meets a chunk scoring
 * at least config.reranker.relevantScore, the bot answers from the notes. The
 * score table shows which cut-off keeps real chat as chat.
 *
 * The confusion matrix shows *which* mistakes happen: rows are the expected
 * label, columns what the router answered.
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { listCompletedFilenames } from "../src/db/documents.js";
import { rankedCandidates } from "../src/rag/retrieve.js";
import { needsRewrite } from "../src/rag/rewrite.js";
import { resolveRoute, routeMessage } from "../src/rag/router.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

interface RouterCase {
  id: string;
  message: string;
  history?: HistoryMessage[];
  route: "document" | "chat";
  mode?: "focused" | "multi_part" | "broad";
}

/** The documents a student would have uploaded while asking these messages. */
const DOCUMENTS = [
  "DataStructure_Chapter1.pdf",
  "DataStructure_Chapter2.pdf",
  "Algorithm-Chapter4.pdf",
  "زلزلهٔ لیسبون ۱۷۵۵.pdf",
  // A name that says nothing about the content (an expert-systems handout).
  "CamScanner 05-18-2025 16.58.pdf",
];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const withSearch = args.includes("--with-search");
const userIndex = args.indexOf("--user");

/** Whose documents the early search uses: --user, or the user with the most documents. */
async function searchUser(): Promise<number> {
  if (userIndex >= 0) return Number(args[userIndex + 1]);
  const result = await pool.query<{ user_id: number }>(
    `SELECT user_id FROM documents WHERE status = 'completed'
     GROUP BY user_id ORDER BY count(*) DESC LIMIT 1`,
  );
  return result.rows[0]!.user_id;
}

const userId = withSearch ? await searchUser() : null;
const documents = userId === null ? DOCUMENTS : await listCompletedFilenames(userId);
/** Per message: best reranker score of the early search (production only searches early for non-follow-ups). */
const scores: { id: string; route: string; routerSaid: string; score: number }[] = [];

const cases = (
  JSON.parse(await readFile("eval/router.json", "utf-8")) as RouterCase[]
).filter((c) => !only || c.id.includes(only));

const label = (route: string, mode?: string) =>
  route === "chat" ? "chat" : `doc:${mode}`;

const labels = ["chat", "doc:focused", "doc:multi_part", "doc:broad"];
const matrix = new Map<string, Map<string, number>>(
  labels.map((row) => [row, new Map(labels.map((col) => [col, 0]))]),
);

const rows: Record<string, string | number>[] = [];
let routeCorrect = 0;
let exactCorrect = 0;
let totalMs = 0;

for (const c of cases) {
  const start = performance.now();
  let actual: string;

  try {
    let result = await routeMessage(c.message, documents, c.history ?? []);
    const routerSaid = result.route;

    if (userId !== null && !needsRewrite(c.message, c.history ?? [])) {
      const score = (await rankedCandidates(userId, c.message))[0]?.rerankScore;
      if (score !== undefined) scores.push({ id: c.id, route: c.route, routerSaid, score });
      result = resolveRoute(result, score);
    }

    actual = label(result.route, result.retrievalMode);
    if (result.route === c.route) routeCorrect++;
  } catch (error: unknown) {
    actual = "error";
    console.warn(`${c.id}: router failed`, error);
  }

  const ms = performance.now() - start;
  totalMs += ms;

  const expected = label(c.route, c.mode);
  if (actual === expected) exactCorrect++;
  const cell = matrix.get(expected)?.get(actual);
  if (cell !== undefined) matrix.get(expected)!.set(actual, cell + 1);

  rows.push({
    id: c.id,
    expected,
    actual,
    ok: actual === expected ? "yes" : "NO",
    ms: Math.round(ms),
  });
}

console.table(rows);

console.log("\nConfusion matrix (rows = expected, columns = router):");
console.table(
  Object.fromEntries(
    labels.map((row) => [row, Object.fromEntries(matrix.get(row)!)]),
  ),
);

const n = rows.length;
const pct = (value: number) => `${((value / Math.max(n, 1)) * 100).toFixed(0)}%`;

console.log(
  `cases=${n}  route accuracy=${pct(routeCorrect)}  ` +
    `route+mode accuracy=${pct(exactCorrect)}  avgMs=${Math.round(totalMs / Math.max(n, 1))}` +
    (userId === null ? "" : `  (with the notes overruling "chat" at score >= ${config.reranker.relevantScore})`),
);

if (userId !== null) {
  const chat = scores.filter((s) => s.route === "chat").map((s) => s.score);
  const rescuable = scores.filter((s) => s.route === "document" && s.routerSaid === "chat");
  const fmt = (values: number[]) =>
    values.length === 0 ? "-" : `${Math.min(...values).toFixed(2)} .. ${Math.max(...values).toFixed(2)}`;

  console.log(`
Early-search best scores (user ${userId}): chat messages ${fmt(chat)}, ` +
    `document messages ${fmt(scores.filter((s) => s.route === "document").map((s) => s.score))}`);
  console.log(`Document messages the router sent to chat: ${rescuable.map((s) => `${s.id} (${s.score.toFixed(2)})`).join(", ") || "none"}`);
  console.table(
    [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((cutoff) => ({
      "cut-off": cutoff,
      "chat wrongly sent to notes": chat.filter((score) => score >= cutoff).length,
      "router mistakes fixed": rescuable.filter((s) => s.score >= cutoff).length,
      current: cutoff === config.reranker.relevantScore ? "<-" : "",
    })),
  );
  console.table(scores.sort((a, b) => b.score - a.score).map((s) => ({ ...s, score: s.score.toFixed(2) })));
}

await pool.end();
