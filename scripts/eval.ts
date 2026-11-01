/**
 * Retrieval evaluation: for each question, checks whether a page that contains
 * the answer is found, how high it ranks, and whether it reaches the model.
 *
 *   npm run eval                          # all questions
 *   npm run eval -- --only lisbon         # questions whose id contains "lisbon"
 *   npm run eval -- --no-rewrite          # skip LLM rewriting of follow-ups
 *   npm run eval -- --no-save             # don't write eval/results/*.json
 *   npm run eval -- --doc "x.pdf=12"      # pin a document version (before/after)
 *
 * Question types (eval/questions.json):
 *   exact_term  - uses the same words as the slide (names, formulas, acronyms)
 *   paraphrase  - asks the same thing in different words
 *   multi_page  - the answer is spread over several pages
 *   follow_up   - only makes sense with the earlier conversation ("history")
 *   negative    - the answer is NOT in the document (expectedPages: [])
 *
 * Each run is saved and compared with the previous one, so a change that makes
 * some questions worse is visible immediately (regression check).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import {
  rankedCandidates,
  relevantHits,
  retrieveContext,
  retrieveRelevantChunks,
  searchCandidates,
} from "../src/rag/retrieve.js";
import { rerankChunks } from "../src/rag/rerank.js";
import { rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

type QuestionType = "exact_term" | "paraphrase" | "multi_page" | "follow_up" | "negative";

interface EvalQuestion {
  id: string;
  type: QuestionType;
  filename: string;
  mode: "focused" | "multi_part" | "broad";
  question: string;
  expectedPages: number[];
  history?: HistoryMessage[];
}

interface Row {
  id: string;
  type: QuestionType;
  filename: string;
  /** 1-based rank of the first chunk on an expected page; 0 = not in top `limit`. */
  rank: number;
  /** Distance of that chunk (positives) or of the best chunk (negatives). */
  distance: number | null;
  /** Distance of the best chunk on a wrong page. */
  wrongDistance: number | null;
  /** Expected page present in the context the model would really get. */
  inContext: boolean;
  /**
   * Follow-ups: vector rank of the message as typed, before rewriting. The other
   * ranks use the rewritten question (and the previous answer's hits), like production.
   */
  originalRank?: number;
  /** Rank in hybrid search (vector + keyword, RRF); equals `rank` when hybrid is off. */
  hybridRank: number;
  /** Rank after the reranker re-ordered the hybrid candidates (the production order). */
  rerankRank: number;
  /** Reranker score of the first correct chunk (positives) or of the best chunk (negatives). */
  rerankScore?: number | null;
  rewritten?: string;
  pages: string;
  ms: number;
}

const RESULTS_DIR = "eval/results";
/** Search without the production threshold so every distance can be seen. */
const NO_THRESHOLD = 2;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const limit = Number(flag("limit") ?? 10);
const only = flag("only");
const useRewrite = !args.includes("--no-rewrite");
const save = !args.includes("--no-save");
const threshold = config.rag.maxCosineDistance;

/** --doc "name.pdf=12": use that document version instead of the newest one (before/after comparisons). */
const pinned = new Map(
  args
    .flatMap((arg, i) => (args[i - 1] === "--doc" ? [arg] : []))
    .map((pair) => {
      const at = pair.lastIndexOf("=");
      return [pair.slice(0, at), Number(pair.slice(at + 1))] as const;
    }),
);

const questions = (
  JSON.parse(await readFile("eval/questions.json", "utf-8")) as EvalQuestion[]
).filter((q) => !only || q.id.includes(only));

async function findDocument(filename: string) {
  const found = await pool.query<{ id: number; user_id: number }>(
    `SELECT id, user_id FROM documents
     WHERE filename = $1 AND status = 'completed'
       AND ($2::integer IS NULL OR id = $2)
     ORDER BY id DESC LIMIT 1`,
    [filename, pinned.get(filename) ?? null],
  );
  return found.rows[0];
}

interface PageSpan {
  pageNumber: number | null;
  pageEnd?: number | null;
}

/** True when a chunk's pages (it may cross a page break) include an expected page. */
function covers(chunk: PageSpan, expected: number[]): boolean {
  if (chunk.pageNumber === null) return false;
  const end = chunk.pageEnd ?? chunk.pageNumber;
  return expected.some((page) => page >= chunk.pageNumber! && page <= end);
}

/** 1-based rank of the first chunk on an expected page, 0 if none. */
function rankOf(chunks: PageSpan[], expected: number[]): number {
  return chunks.findIndex((chunk) => covers(chunk, expected)) + 1;
}

const span = (chunk: PageSpan) =>
  chunk.pageEnd && chunk.pageEnd !== chunk.pageNumber
    ? `${chunk.pageNumber}-${chunk.pageEnd}`
    : String(chunk.pageNumber);

/**
 * What a follow-up's previous answer was based on (production reads it from
 * answer_logs): the relevant hits for the last user message in the history.
 */
async function previousHits(
  document: { id: number; user_id: number },
  history: HistoryMessage[] = [],
): Promise<number[]> {
  const last = [...history].reverse().find((message) => message.role === "user");
  if (!last) return [];

  const ranked = relevantHits(await rankedCandidates(document.user_id, last.content, document.id));
  return ranked.slice(0, config.rag.retrievalLimits.focused).map((chunk) => chunk.chunkIndex);
}

const rows: Row[] = [];

for (const q of questions) {
  const document = await findDocument(q.filename);

  if (!document) {
    console.warn(`Skipping ${q.id}: no completed document named ${q.filename}`);
    continue;
  }

  // Like production: follow-ups are rewritten before searching, and the
  // previous answer's hits compete with the search results.
  const rewritten =
    q.type === "follow_up" && useRewrite && q.history
      ? await rewriteQuestion(q.question, q.history)
      : undefined;
  const text = rewritten ?? q.question;
  const include = q.type === "follow_up" ? await previousHits(document, q.history) : [];

  const start = performance.now();
  const chunks = await retrieveRelevantChunks(
    document.user_id,
    text,
    limit,
    document.id,
    NO_THRESHOLD,
  );
  const ms = performance.now() - start;

  const distances = chunks.map((chunk) => Number(chunk.distance));
  const rank = rankOf(chunks, q.expectedPages);
  // Hybrid search (vector + keyword, RRF), then the reranker on top, like production.
  const hybrid = await searchCandidates(
    document.user_id,
    text,
    limit,
    document.id,
    NO_THRESHOLD,
    include,
  );
  const hybridRank = rankOf(hybrid, q.expectedPages);
  const reranked = await rerankChunks(text, hybrid);
  const rerankRank = rankOf(reranked, q.expectedPages);
  const scored = q.type === "negative" ? reranked[0] : reranked[rerankRank - 1];
  const wrongIndex = chunks.findIndex((chunk) => !covers(chunk, q.expectedPages));

  const mode = q.mode === "broad" ? "multi_part" : q.mode;
  const context = await retrieveContext(
    document.user_id,
    text,
    mode,
    document.id,
    include.length > 0 ? await rankedCandidates(document.user_id, text, document.id, include) : undefined,
  );

  const row: Row = {
    id: q.id,
    type: q.type,
    filename: q.filename,
    rank,
    hybridRank,
    rerankRank,
    rerankScore: scored?.rerankScore ?? null,
    distance:
      q.type === "negative" ? (distances[0] ?? null) : rank > 0 ? distances[rank - 1]! : null,
    wrongDistance: wrongIndex >= 0 ? distances[wrongIndex]! : null,
    inContext: rankOf(context, q.expectedPages) > 0,
    pages: chunks.slice(0, 5).map(span).join(","),
    ms: Math.round(ms),
  };

  if (rewritten !== undefined) {
    const originalChunks = await retrieveRelevantChunks(
      document.user_id,
      q.question,
      limit,
      document.id,
      NO_THRESHOLD,
    );
    row.rewritten = rewritten;
    row.originalRank = rankOf(originalChunks, q.expectedPages);
  }

  rows.push(row);
}

// --- Per-question table -------------------------------------------------------

const fmt = (value: number | null) => (value === null ? "-" : value.toFixed(3));

console.table(
  rows.map((row) => ({
    id: row.id,
    type: row.type,
    rank: row.type === "negative" ? "" : row.rank || "MISS",
    hybrid: row.type === "negative" ? "" : row.hybridRank || "MISS",
    reranked: row.type === "negative" ? "" : row.rerankRank || "MISS",
    dist: fmt(row.distance),
    wrong: fmt(row.wrongDistance),
    context: row.type === "negative" ? "" : row.inContext ? "yes" : "NO",
    "as typed": row.originalRank === undefined ? "" : row.originalRank || "MISS",
    pages: row.pages,
    ms: row.ms,
  })),
);

for (const row of rows.filter((r) => r.rewritten)) {
  console.log(`rewrite ${row.id}: ${row.rewritten}`);
}

// --- Metrics --------------------------------------------------------------------

interface Metrics {
  n: number;
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  hybridHit1: number;
  hybridMrr: number;
  rerankHit1: number;
  rerankHit3: number;
  rerankMrr: number;
  context: number;
}

function metrics(group: Row[]): Metrics {
  const n = group.length;
  const share = (test: (row: Row) => boolean) =>
    n === 0 ? 0 : group.filter(test).length / n;
  const mrr = (rankOf: (row: Row) => number) =>
    n === 0 ? 0 : group.reduce((sum, row) => sum + (rankOf(row) ? 1 / rankOf(row) : 0), 0) / n;

  return {
    n,
    hit1: share((row) => row.rank === 1),
    hit3: share((row) => row.rank >= 1 && row.rank <= 3),
    hit5: share((row) => row.rank >= 1 && row.rank <= 5),
    mrr: mrr((row) => row.rank),
    hybridHit1: share((row) => row.hybridRank === 1),
    hybridMrr: mrr((row) => row.hybridRank),
    rerankHit1: share((row) => row.rerankRank === 1),
    rerankHit3: share((row) => row.rerankRank >= 1 && row.rerankRank <= 3),
    rerankMrr: mrr((row) => row.rerankRank),
    context: share((row) => row.inContext),
  };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const positives = rows.filter((row) => row.type !== "negative");
const negatives = rows.filter((row) => row.type === "negative");
const types = [...new Set(positives.map((row) => row.type))];

const byType: Record<string, Metrics> = { all: metrics(positives) };
for (const type of types) byType[type] = metrics(positives.filter((r) => r.type === type));

// Per document too: slide decks and plain-text notes behave differently.
for (const filename of new Set(positives.map((row) => row.filename))) {
  byType[`📄 ${filename.slice(0, 24)}`] = metrics(positives.filter((r) => r.filename === filename));
}

console.log("\nRetrieval (answerable questions):");
console.table(
  Object.fromEntries(
    Object.entries(byType).map(([type, m]) => [
      type,
      {
        n: m.n,
        "hit@1": pct(m.hit1),
        "hit@3": pct(m.hit3),
        "hit@5": pct(m.hit5),
        MRR: m.mrr.toFixed(3),
        "hybrid hit@1": pct(m.hybridHit1),
        "hybrid MRR": m.hybridMrr.toFixed(3),
        "+rerank hit@1": pct(m.rerankHit1),
        "+rerank hit@3": pct(m.rerankHit3),
        "+rerank MRR": m.rerankMrr.toFixed(3),
        "in context": pct(m.context),
      },
    ]),
  ),
);

// Negatives: with the production threshold, would the bot still find "something"?
const falsePositives = negatives.filter(
  (row) => row.distance !== null && row.distance <= threshold,
).length;
console.log(
  `Negatives: ${falsePositives}/${negatives.length} still retrieve chunks under the ` +
    `threshold ${threshold} (the model must then refuse on its own).`,
);

const followUps = rows.filter((row) => row.originalRank !== undefined);
if (followUps.length > 0) {
  const found = (ranks: number[]) => ranks.filter((rank) => rank >= 1 && rank <= 3).length;
  console.log(
    `Follow-ups hit@3: as typed ${found(followUps.map((r) => r.originalRank!))}/${followUps.length}, ` +
      `rewritten ${found(followUps.map((r) => r.rank))}/${followUps.length}, ` +
      `+ previous answer's hits, reranked ${found(followUps.map((r) => r.rerankRank))}/${followUps.length}`,
  );
}

// --- Threshold calibration ------------------------------------------------------
// A threshold is good when correct chunks are under it and negatives are above it.

const correct = positives.map((row) => row.distance ?? Infinity);
const negativeBest = negatives.map((row) => row.distance ?? Infinity);
const calibration: { threshold: number; keepsCorrect: number; rejectsNegatives: number }[] = [];

for (let t = 0.3; t <= 0.701; t += 0.05) {
  calibration.push({
    threshold: Number(t.toFixed(2)),
    keepsCorrect: correct.filter((d) => d <= t).length / Math.max(correct.length, 1),
    rejectsNegatives:
      negativeBest.filter((d) => d > t).length / Math.max(negativeBest.length, 1),
  });
}

const finite = (values: number[]) => values.filter(Number.isFinite).sort((a, b) => a - b);
const range = (values: number[]) => {
  const sorted = finite(values);
  return sorted.length === 0
    ? "-"
    : `${sorted[0]!.toFixed(3)} .. ${sorted[sorted.length - 1]!.toFixed(3)}`;
};

console.log(
  `\nDistances: correct chunks ${range(correct)}, ` +
    `best wrong chunks ${range(positives.map((r) => r.wrongDistance ?? Infinity))}, ` +
    `negatives' best chunk ${range(negativeBest)}`,
);
console.table(
  calibration.map((c) => ({
    threshold: c.threshold,
    "keeps correct": pct(c.keepsCorrect),
    "rejects negatives": pct(c.rejectsNegatives),
    current: c.threshold === threshold ? "<-" : "",
  })),
);

// --- Reranker score calibration (config.reranker.minScore) -----------------------
// Hits scored below the minimum are dropped; with none left the bot refuses
// without calling the LLM. Pick the highest value that still keeps ~98% of correct chunks.

const minScore = config.reranker.minScore;
const correctScores = finite(positives.map((r) => r.rerankScore ?? Number.NaN));
const negativeScores = finite(negatives.map((r) => r.rerankScore ?? Number.NaN));

if (correctScores.length > 0) {
  console.log(
    `\nReranker scores: correct chunks ${range(correctScores)}, negatives' best chunk ${range(negativeScores)}`,
  );

  const lowest = Math.min(...correctScores, ...negativeScores);
  const highest = Math.max(...correctScores, ...negativeScores);
  const steps = 10;
  const candidates = [
    ...Array.from({ length: steps + 1 }, (_, i) => lowest + ((highest - lowest) * i) / steps),
    ...(minScore === null ? [] : [minScore]),
  ].sort((a, b) => a - b);

  console.table(
    candidates.map((t) => ({
      "min score": Number(t.toFixed(3)),
      "keeps correct": pct(correctScores.filter((s) => s >= t).length / correctScores.length),
      "rejects negatives": pct(
        negativeScores.filter((s) => s < t).length / Math.max(negativeScores.length, 1),
      ),
      current: t === minScore ? "<-" : "",
    })),
  );
} else {
  console.log("\nReranker scores: none (reranker off or down).");
}

// --- Save and compare with the previous run -------------------------------------

async function previousResult(): Promise<{ file: string; rows: Row[] } | null> {
  try {
    const files = (await readdir(RESULTS_DIR)).filter((f) => f.startsWith("retrieval-")).sort();
    const file = files.at(-1);
    if (!file) return null;
    const data = JSON.parse(await readFile(`${RESULTS_DIR}/${file}`, "utf-8")) as { rows: Row[] };
    return { file, rows: data.rows };
  } catch {
    return null;
  }
}

const previous = await previousResult();

if (previous) {
  const before = new Map(previous.rows.map((row) => [row.id, row]));
  const changes: string[] = [];
  const score = (rank: number) => (rank === 0 ? Infinity : rank);

  for (const row of positives) {
    const old = before.get(row.id);
    if (!old || old.rank === row.rank) continue;
    const better = score(row.rank) < score(old.rank);
    changes.push(
      `${better ? "better" : "WORSE "} ${row.id}: rank ${old.rank || "MISS"} -> ${row.rank || "MISS"}`,
    );
  }

  console.log(`\nCompared with ${previous.file}:`);
  console.log(changes.length > 0 ? changes.join("\n") : "no rank changes");
}

if (save) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    `${RESULTS_DIR}/retrieval-${stamp}.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        settings: {
          limit,
          threshold,
          minRerankScore: config.reranker.minScore,
          retrievalLimits: config.rag.retrievalLimits,
          maxContextChunks: config.rag.maxContextChunks,
          chunkSize: config.rag.chunkSize,
        },
        metrics: byType,
        falsePositives,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved ${RESULTS_DIR}/retrieval-${stamp}.json`);
}

await pool.end();
