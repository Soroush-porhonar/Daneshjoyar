/**
 * Router evaluation: sends labelled messages to the router and measures how
 * often it picks the right route (document/chat) and retrieval mode.
 *
 *   npm run eval:router
 *   npm run eval:router -- --only followup
 *   npm run eval:router -- --with-search            # + the notes overruling the router
 *   npm run eval:router -- --with-search --user 1   # whose documents to search
 *   npm run eval:router -- --no-save                # don't write eval/results/router-*.json
 *
 * --with-search also runs the early search (all of a user's documents, by
 * default the user with the most) and records each message's best reranker
 * score. The router sees only file names; when its "chat" meets a chunk scoring
 * at least config.reranker.relevantScore, the bot answers from the notes. The
 * score table shows which cut-off keeps real chat as chat.
 *
 * Cases (eval/router.json): ids starting with "real-" are messages students
 * sent (answer_logs), with the conversation they had. `kind` groups the
 * accuracy; `mode` may list several acceptable modes or be left out (route
 * only); `dependsOnHistory` says whether the message needs the conversation
 * to be understood, which is compared with the rewrite rule (needsRewrite).
 *
 * The confusion matrix shows *which* mistakes happen: rows are the expected
 * label, columns what the router answered. Each run is saved and compared
 * with the previous one.
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { evalUser, previousResult, saveResult, scoreRoute } from "./evalHelpers.js";
import type { RouterCase } from "./evalHelpers.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { listCompletedFilenames } from "../src/db/documents.js";
import { rankedCandidates } from "../src/rag/retrieve.js";
import { needsRewrite } from "../src/rag/rewrite.js";
import { resolveRoute, routeMessage } from "../src/rag/router.js";
import type { MessageClassification } from "../src/rag/router.js";
import { isDocumentInfoQuestion } from "../src/rag/documentInfo.js";
import { isTransformRequest } from "../src/rag/transform.js";

interface Row {
  id: string;
  kind: string;
  expected: string;
  actual: string;
  route: "yes" | "NO";
  ok: "yes" | "NO";
  /** Would the bot rewrite it (needsRewrite)? Blank when the case has no label for it. */
  rewrite: string;
  ms: number;
}

/** The documents a student would have uploaded while asking these messages. */
const DOCUMENTS = [
  "DataStructure_Chapter1.pdf",
  "DataStructure_Chapter2.pdf",
  "Algorithm-Chapter4.pdf",
  "زلزلهٔ لیسبون ۱۷۵۵.pdf",
  // A name that says nothing about the content (an expert-systems handout).
  "CamScanner 05-18-2025 16.58.pdf",
  "جزوه مهندسی نرم افزار - بخش شی گرایی.pdf",
  "جزوه درس آزمون نرم افزاراستاد زاغری 405.pdf",
];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const withSearch = args.includes("--with-search");
const save = !args.includes("--no-save");
/** Whose documents the early search uses: --user, or the owner of the retrieval eval's documents. */
async function searchUser(): Promise<number> {
  const questions = JSON.parse(await readFile("eval/questions.json", "utf-8")) as { filename: string }[];
  return evalUser(args, questions.map((q) => q.filename));
}

const userId = withSearch ? await searchUser() : null;
const documents = userId === null ? DOCUMENTS : await listCompletedFilenames(userId);
/** Per message: best reranker score of the early search (production only searches early for non-follow-ups). */
const scores: { id: string; route: string; routerSaid: string; score: number }[] = [];

const cases = (
  JSON.parse(await readFile("eval/router.json", "utf-8")) as RouterCase[]
).filter((c) => !only || c.id.includes(only));

const labels = ["chat", "info", "transform", "doc:focused", "doc:multi_part", "doc:broad"];
const matrix = new Map<string, Map<string, number>>(
  labels.map((row) => [row, new Map(labels.map((col) => [col, 0]))]),
);

const rows: Row[] = [];
let totalMs = 0;
/** Per case: did the bot treat the message as a follow-up (router decision, or the length rule as fallback)? */
const decisions = new Map<string, boolean>();

for (const c of cases) {
  const history = c.history ?? [];
  // Like production: the router decides whether the message depends on the
  // conversation (the length rule only when it gives no decision); a follow-up
  // does not get the early-search override.
  let rewrites = needsRewrite(c.message, history);
  const start = performance.now();
  let outcome = { routeOk: false, exactOk: false, expectedLabel: scoreRoute(c, { route: c.route, retrievalMode: "focused" }).expectedLabel, actualLabel: "error" };

  try {
    // Like the bot: reshaping the previous answer, and questions about a document
    // itself, are decided by rules, not the router. (The bot also checks that the
    // previous answer came from the notes; every eval history's answer does.)
    let result: MessageClassification =
      history.at(-1)?.role === "assistant" && isTransformRequest(c.message)
        ? { route: "transform", retrievalMode: "focused", dependsOnHistory: true, standaloneQuestion: null }
        : isDocumentInfoQuestion(c.message)
          ? { route: "document_info", retrievalMode: "focused", dependsOnHistory: false, standaloneQuestion: null }
          : await routeMessage(c.message, documents, history);
    const routerSaid = result.route;
    rewrites = result.dependsOnHistory ?? rewrites;
    decisions.set(c.id, rewrites);

    if (userId !== null && !rewrites) {
      const score = (await rankedCandidates(userId, c.message))[0]?.rerankScore;
      if (score !== undefined) scores.push({ id: c.id, route: c.route, routerSaid, score });
      result = resolveRoute(result, score);
    }

    outcome = scoreRoute(c, result);
  } catch (error: unknown) {
    console.warn(`${c.id}: router failed`, error);
  }

  const ms = performance.now() - start;
  totalMs += ms;

  const cell = matrix.get(outcome.expectedLabel)?.get(outcome.actualLabel);
  if (cell !== undefined) matrix.get(outcome.expectedLabel)!.set(outcome.actualLabel, cell + 1);

  rows.push({
    id: c.id,
    kind: c.kind ?? "-",
    expected: outcome.expectedLabel,
    actual: outcome.actualLabel,
    route: outcome.routeOk ? "yes" : "NO",
    ok: outcome.exactOk ? "yes" : "NO",
    rewrite:
      c.dependsOnHistory === undefined
        ? ""
        : `${rewrites ? "yes" : "no"}${rewrites === c.dependsOnHistory ? "" : " (WRONG)"}`,
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

const share = (part: number, whole: number) => `${((part / Math.max(whole, 1)) * 100).toFixed(0)}%`;
const routeCorrect = (group: Row[]) => group.filter((row) => row.route === "yes").length;
const exactCorrect = (group: Row[]) => group.filter((row) => row.ok === "yes").length;

const byKind = Object.fromEntries(
  [...new Set(rows.map((row) => row.kind))].map((kind) => {
    const group = rows.filter((row) => row.kind === kind);
    return [
      kind,
      {
        n: group.length,
        route: `${routeCorrect(group)}/${group.length}`,
        "route+mode": `${exactCorrect(group)}/${group.length}`,
      },
    ];
  }),
);

console.log("\nBy kind of message:");
console.table(byKind);

// The follow-up decision against the labels: a standalone question that is rewritten
// costs a model call and can change its meaning; a follow-up that is not is searched as typed.
const rewritten = (c: RouterCase) => decisions.get(c.id) ?? needsRewrite(c.message, c.history ?? []);
const labelled = cases.filter((c) => c.dependsOnHistory !== undefined);
const wronglyRewritten = labelled.filter((c) => !c.dependsOnHistory && rewritten(c));
const missedFollowUps = labelled.filter((c) => c.dependsOnHistory && !rewritten(c));
const standalone = labelled.filter((c) => !c.dependsOnHistory).length;
const lengthRuleRight = labelled.filter((c) => needsRewrite(c.message, c.history ?? []) === c.dependsOnHistory).length;

if (labelled.length > 0) {
  console.log(
    `\nFollow-up decision (router; length rule alone: ${lengthRuleRight}/${labelled.length} right) on ${labelled.length} messages with history: ` +
      `${labelled.length - wronglyRewritten.length - missedFollowUps.length} right; ` +
      `standalone messages rewritten ${wronglyRewritten.length}/${standalone}; ` +
      `follow-ups not rewritten ${missedFollowUps.length}/${labelled.length - standalone}`,
  );
  if (wronglyRewritten.length > 0) console.log(`  rewritten needlessly: ${wronglyRewritten.map((c) => c.id).join(", ")}`);
  if (missedFollowUps.length > 0) console.log(`  follow-ups missed: ${missedFollowUps.map((c) => c.id).join(", ")}`);
}

const n = rows.length;
const real = rows.filter((row) => row.id.startsWith("real-"));

console.log(
  `\ncases=${n}  route accuracy=${share(routeCorrect(rows), n)}  ` +
    `route+mode accuracy=${share(exactCorrect(rows), n)}  avgMs=${Math.round(totalMs / Math.max(n, 1))}` +
    (userId === null ? "" : `  (with the notes overruling "chat" at score >= ${config.reranker.relevantScore})`),
);
if (real.length > 0) {
  console.log(
    `real messages (${real.length}): route ${share(routeCorrect(real), real.length)}, ` +
      `route+mode ${share(exactCorrect(real), real.length)}`,
  );
}

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

// --- Save and compare with the previous run -------------------------------------

const previous = await previousResult<{ withSearch?: boolean; rows: Row[] }>("router");

if (previous) {
  const before = new Map(previous.data.rows.map((row) => [row.id, row]));
  const changes = rows.flatMap((row) => {
    const old = before.get(row.id);
    if (!old || old.actual === row.actual) return [];
    const verdict = row.ok === old.ok ? "changed" : row.ok === "yes" ? "better " : "WORSE  ";
    return [`${verdict} ${row.id}: ${old.actual} -> ${row.actual} (expected ${row.expected})`];
  });
  const added = rows.filter((row) => !before.has(row.id)).length;

  console.log(
    `\nCompared with ${previous.file}` +
      (previous.data.withSearch === withSearch ? "" : " (a run with a different --with-search setting)") +
      (added > 0 ? `; ${added} cases are new` : "") +
      ":",
  );
  console.log(changes.length > 0 ? changes.join("\n") : "no decision changed");
}

if (save && !only) {
  const path = await saveResult("router", {
    withSearch,
    userId,
    relevantScore: config.reranker.relevantScore,
    summary: {
      cases: n,
      routeCorrect: routeCorrect(rows),
      exactCorrect: exactCorrect(rows),
      realCases: real.length,
      realRouteCorrect: routeCorrect(real),
      realExactCorrect: exactCorrect(real),
      standaloneRewritten: wronglyRewritten.length,
      standaloneLabelled: standalone,
      followUpsMissed: missedFollowUps.length,
      avgMs: Math.round(totalMs / Math.max(n, 1)),
    },
    byKind,
    rows,
  });
  console.log(`\nSaved ${path}`);
}

await pool.end();
