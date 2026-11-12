/**
 * Retrieval evaluation: for each question, checks whether a page that contains
 * the answer is found, how high it ranks, and whether it reaches the model.
 *
 *   npm run eval                          # all questions
 *   npm run eval -- --only lisbon         # questions whose id contains "lisbon"
 *   npm run eval -- --no-rewrite          # skip LLM rewriting of follow-ups
 *   npm run eval -- --no-save             # don't write eval/results/*.json
 *   npm run eval -- --doc "x.pdf=12"      # pin a document version (before/after)
 *   npm run eval -- --per-doc             # search only each question's own document
 *   npm run eval -- --user 42             # that user's copies of the documents (distractor run)
 *
 * Like the bot, each question searches all documents of the user who owns its
 * document; a hit counts only if it is on the right page of the right file.
 * "wrong-document" counts top-3 chunks from other files.
 *
 * Question types (eval/questions.json):
 *   exact_term  - uses the same words as the slide (names, formulas, acronyms)
 *   paraphrase  - asks the same thing in different words
 *   multi_page  - the answer is spread over several pages
 *   follow_up   - only makes sense with the earlier conversation ("history")
 *   standalone_history - a complete question asked after an earlier exchange;
 *                 the bot rewrites it anyway (short message after history),
 *                 which must not make it worse
 *   negative    - the answer is NOT in the document (expectedPages: [])
 *
 * Optional fields:
 *   parts    - multi-concept questions: the pages of each concept; "every
 *              part" counts the questions where each part reached the model
 *   tags     - english, finglish, typo, arabic_letters, table, formula,
 *              near_miss: one metrics row per tag
 *   holdout  - reported on its own row; do not tune against these
 *
 * Each run is saved and compared with the previous one, so a change that makes
 * some questions worse is visible immediately (regression check).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { bootstrapInterval, pairedInterval } from "./bootstrap.js";
import { previousHits } from "./evalHelpers.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import {
  rankedCandidates,
  retrieveContext,
  retrieveRelevantChunks,
  searchCandidates,
} from "../src/rag/retrieve.js";
import { rerankChunks } from "../src/rag/rerank.js";
import { needsRewrite, rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

type QuestionType = "exact_term" | "paraphrase" | "multi_page" | "follow_up" | "standalone_history" | "negative";

interface EvalQuestion {
  id: string;
  type: QuestionType;
  filename: string;
  mode: "focused" | "multi_part" | "broad";
  question: string;
  expectedPages: number[];
  history?: HistoryMessage[];
  parts?: number[][];
  tags?: string[];
  holdout?: boolean;
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
  /** Multi-concept questions: how many parts, and how many had a page in that context. */
  parts?: number;
  partsInContext?: number;
  tags?: string[];
  holdout?: boolean;
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
  /** How many of the top 3 reranked chunks come from another document (0 in --per-doc runs). */
  wrongDocumentsTop3?: number;
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
const perDocument = args.includes("--per-doc");
const threshold = config.rag.maxCosineDistance;

/**
 * --user 42: use that user's copies of the eval documents (the distractor run: the
 * eval PDFs ingested with many other documents under a separate user).
 */
const evalUserIndex = args.indexOf("--user");
const evalUser = evalUserIndex >= 0 ? Number(args[evalUserIndex + 1]) : null;

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
       AND ($3::integer IS NULL OR user_id = $3)
     ORDER BY id DESC LIMIT 1`,
    [filename, pinned.get(filename) ?? null, evalUser],
  );
  return found.rows[0];
}

interface PageSpan {
  documentId: number;
  pageNumber: number | null;
  pageEnd?: number | null;
}

/** True when a chunk is in the expected document and its pages (it may cross a page break) include an expected page. */
function covers(chunk: PageSpan, documentId: number, expected: number[]): boolean {
  if (chunk.documentId !== documentId || chunk.pageNumber === null) return false;
  const end = chunk.pageEnd ?? chunk.pageNumber;
  return expected.some((page) => page >= chunk.pageNumber! && page <= end);
}

/** 1-based rank of the first chunk on an expected page of the expected document, 0 if none. */
function rankOf(chunks: PageSpan[], documentId: number, expected: number[]): number {
  return chunks.findIndex((chunk) => covers(chunk, documentId, expected)) + 1;
}

/** Pages for the table; chunks from another document are marked with "x". */
const span = (chunk: PageSpan, documentId: number) =>
  (chunk.documentId === documentId ? "" : "x") +
  (chunk.pageEnd && chunk.pageEnd !== chunk.pageNumber
    ? `${chunk.pageNumber}-${chunk.pageEnd}`
    : String(chunk.pageNumber));

const rows: Row[] = [];

for (const q of questions) {
  const document = await findDocument(q.filename);

  if (!document) {
    console.warn(`Skipping ${q.id}: no completed document named ${q.filename}`);
    continue;
  }

  // Like production: a short message after an earlier exchange is rewritten
  // before searching, and the previous answer's hits compete with the results.
  const followUp = q.history !== undefined && needsRewrite(q.question, q.history);
  const rewritten = followUp && useRewrite ? await rewriteQuestion(q.question, q.history!) : undefined;
  const text = rewritten ?? q.question;
  // Like the bot: all of the user's documents, unless --per-doc.
  const scopeId = perDocument ? document.id : undefined;
  const scope = scopeId === undefined ? {} : { documentId: scopeId };
  const include = followUp ? await previousHits(document, q.history, scopeId) : [];

  const start = performance.now();
  const chunks = await retrieveRelevantChunks(
    document.user_id,
    text,
    limit,
    scopeId,
    NO_THRESHOLD,
  );
  const ms = performance.now() - start;

  const distances = chunks.map((chunk) => Number(chunk.distance));
  const rank = rankOf(chunks, document.id, q.expectedPages);
  // Hybrid search (vector + keyword, RRF), then the reranker on top, like production.
  const hybrid = await searchCandidates(
    document.user_id,
    text,
    limit,
    scopeId,
    NO_THRESHOLD,
    include,
  );
  const hybridRank = rankOf(hybrid, document.id, q.expectedPages);
  const reranked = await rerankChunks(text, hybrid);
  const rerankRank = rankOf(reranked, document.id, q.expectedPages);
  const scored = q.type === "negative" ? reranked[0] : reranked[rerankRank - 1];
  const wrongIndex = chunks.findIndex((chunk) => !covers(chunk, document.id, q.expectedPages));

  const mode = q.mode === "broad" ? "multi_part" : q.mode;
  const context = await retrieveContext(
    document.user_id,
    text,
    mode,
    {
      ...scope,
      ...(include.length > 0
        ? { ranked: await rankedCandidates(document.user_id, text, { ...scope, include }) }
        : {}),
    },
  );

  const row: Row = {
    id: q.id,
    type: q.type,
    filename: q.filename,
    rank,
    hybridRank,
    rerankRank,
    rerankScore: scored?.rerankScore ?? null,
    wrongDocumentsTop3: reranked.slice(0, 3).filter((chunk) => chunk.documentId !== document.id).length,
    distance:
      q.type === "negative" ? (distances[0] ?? null) : rank > 0 ? distances[rank - 1]! : null,
    wrongDistance: wrongIndex >= 0 ? distances[wrongIndex]! : null,
    inContext: rankOf(context, document.id, q.expectedPages) > 0,
    ...(q.parts
      ? { parts: q.parts.length, partsInContext: q.parts.filter((pages) => rankOf(context, document.id, pages) > 0).length }
      : {}),
    ...(q.tags ? { tags: q.tags } : {}),
    ...(q.holdout ? { holdout: true } : {}),
    pages: chunks.slice(0, 5).map((chunk) => span(chunk, document.id)).join(","),
    ms: Math.round(ms),
  };

  if (rewritten !== undefined) {
    const originalChunks = await retrieveRelevantChunks(
      document.user_id,
      q.question,
      limit,
      scopeId,
      NO_THRESHOLD,
    );
    row.rewritten = rewritten;
    row.originalRank = rankOf(originalChunks, document.id, q.expectedPages);
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

// Ways of asking (english, typo, table, ...) and the held-out questions.
for (const tag of new Set(positives.flatMap((row) => row.tags ?? []))) {
  byType[`#${tag}`] = metrics(positives.filter((r) => r.tags?.includes(tag)));
}
const heldOut = positives.filter((row) => row.holdout);
if (heldOut.length > 0) byType["held out"] = metrics(heldOut);

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

/** The production-order measures, per question (1 = yes, 0 = no). */
const measures: Record<string, (row: Row) => number> = {
  "+rerank hit@1": (row) => Number(row.rerankRank === 1),
  "+rerank hit@3": (row) => Number(row.rerankRank >= 1 && row.rerankRank <= 3),
  "in context": (row) => Number(row.inContext),
};

const interval = ([low, high]: [number, number]) => `${pct(low)}–${pct(high)}`;

console.log(
  `95% intervals (all, n=${positives.length}): ` +
    Object.entries(measures)
      .map(([name, measure]) => {
        const values = positives.map(measure);
        const share = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
        return `${name} ${pct(share)} (${interval(bootstrapInterval(values))})`;
      })
      .join(", "),
);

const wrongDocuments = positives.reduce((sum, row) => sum + (row.wrongDocumentsTop3 ?? 0), 0);
console.log(
  `Scope: ${perDocument ? "each question's own document (--per-doc)" : "all of the user's documents"}; ` +
    `top-3 reranked chunks from another document: ${pct(wrongDocuments / Math.max(positives.length * 3, 1))} ` +
    `(${positives.filter((row) => (row.wrongDocumentsTop3 ?? 0) > 0).length} questions affected)`,
);

// Negatives: with the production threshold, would the bot still find "something"?
const falsePositives = negatives.filter(
  (row) => row.distance !== null && row.distance <= threshold,
).length;
console.log(
  `Negatives: ${falsePositives}/${negatives.length} still retrieve chunks under the ` +
    `threshold ${threshold} (the model must then refuse on its own).`,
);

const multiPart = positives.filter((row) => row.parts !== undefined);
if (multiPart.length > 0) {
  const parts = multiPart.reduce((sum, row) => sum + row.parts!, 0);
  const found = multiPart.reduce((sum, row) => sum + row.partsInContext!, 0);
  console.log(
    `Multi-concept questions: every part in context ${multiPart.filter((row) => row.partsInContext === row.parts).length}/${multiPart.length}; ` +
      `parts in context ${found}/${parts}`,
  );
}

const nearMiss = negatives.filter((row) => row.tags?.includes("near_miss"));
if (nearMiss.length > 0) {
  console.log(
    `Near-miss unanswerable questions (topic in the notes, fact not): ${nearMiss.length}; ` +
      `best chunk distance ${nearMiss.map((row) => row.distance ?? Infinity).filter(Number.isFinite).map((d) => d.toFixed(2)).sort().join(", ")}`,
  );
}

const followUps = rows.filter((row) => row.originalRank !== undefined);
if (followUps.length > 0) {
  const found = (ranks: number[]) => ranks.filter((rank) => rank >= 1 && rank <= 3).length;
  console.log(
    `Rewritten messages (follow-ups and standalone_history) hit@3: as typed ${found(followUps.map((r) => r.originalRank!))}/${followUps.length}, ` +
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

  // Is the overall change bigger than the noise? (Same questions in both runs.)
  const shared = positives.filter((row) => before.has(row.id));
  const points = (value: number) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}`;

  for (const [name, measure] of Object.entries(measures)) {
    const after = shared.map(measure);
    const old = shared.map((row) => measure(before.get(row.id)!));
    const change = (after.reduce((s, v) => s + v, 0) - old.reduce((s, v) => s + v, 0)) / Math.max(shared.length, 1);
    const [low, high] = pairedInterval(old, after);
    const verdict = low > 0 ? "better" : high < 0 ? "WORSE" : "within noise";

    console.log(
      `${name}: ${points(change)} points (95% ${points(low)} … ${points(high)}) on ${shared.length} shared questions — ${verdict}`,
    );
  }
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
          scope: perDocument ? "per-document" : "all-documents",
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
