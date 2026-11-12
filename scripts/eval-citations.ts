/**
 * Calibration of the citation check (scripts/citationCheck.ts): can the
 * cross-encoder's score tell a citation its source supports from one it does
 * not? Measured on hand-labelled pairs, the same way every other threshold
 * in this project is set.
 *
 *   npm run eval:citations -- --export          # draft eval/citation-labels.json from the newest eval:answers run
 *   npm run eval:citations -- --export --include covid-commensal,covid-distancing
 *   npm run eval:citations -- --export --force  # overwrite labels that exist
 *   npm run eval:citations                      # score the labelled pairs: separation and the best cut-off
 *
 * --export picks about 30 pairs: every pair of the answers named with
 * --include, the lowest-scoring pairs, and pairs spread over the rest of the
 * score range; plus "mismatched" pairs (a sentence against a source from
 * another document), which are unsupported by construction. Each real pair
 * is then labelled by hand: "supported": true when the source text states
 * what the sentence says, false when it does not (wrong fact, garbled name,
 * or the claim is simply not there).
 *
 * The result decides CITATION_SUPPORT_SCORE. If the scores do not separate
 * the labels, the cross-encoder is the wrong tool (it is trained for
 * relevance, not for entailment) and the check needs a different judge.
 * First run, 2026-11-12: they do not (AUC 0.55 on pairs from real answers);
 * only sources from another document are rejected. See citationCheck.ts.
 * The labels are reusable for testing any other judge.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";
import { separation } from "./answerChecks.js";
import { CITATION_SUPPORT_SCORE, checkCitations, supportScore } from "./citationCheck.js";
import type { NumberedSource } from "./citationCheck.js";
import { SOURCES_HEADING } from "../src/messages.js";
import { isRefusal } from "../src/rag/answer.js";
import { previousResult } from "./evalHelpers.js";

const LABELS_FILE = "eval/citation-labels.json";
const REAL_PAIRS = 22;
const MISMATCHED_PAIRS = 8;

interface Label {
  id: string;
  /** "real": taken from an answer. "mismatched": the sentence with a source from another document. */
  kind: "real" | "mismatched";
  sentence: string;
  /** The chunks of the cited source (one page), as the model saw them. */
  chunks: string[];
  /** null until labelled by hand. */
  supported: boolean | null;
  note?: string;
}

interface SavedRun {
  details: { id: string; answer: string; sources?: NumberedSource[] }[];
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

async function exportPairs(): Promise<void> {
  const existing = await readFile(LABELS_FILE, "utf-8").catch(() => null);
  if (existing && !args.includes("--force")) {
    throw new Error(`${LABELS_FILE} exists (hand labels). Pass --force to overwrite it.`);
  }

  const run = await previousResult<SavedRun>("answers");
  if (!run) throw new Error("No saved eval:answers run. Run npm run eval:answers first.");

  const questions = JSON.parse(await readFile("eval/questions.json", "utf-8")) as { id: string; filename: string }[];
  const fileOf = new Map(questions.map((q) => [q.id, q.filename]));
  const include = (flag("include") ?? "").split(",").filter(Boolean);

  // Every citation of the run, split and scored with today's rules, with the text of its source.
  const pairs: { questionId: string; number: number; sentence: string; chunks: string[]; score: number }[] = [];

  for (const detail of run.data.details) {
    const body = detail.answer.split(SOURCES_HEADING)[0]!.trim();
    if (!detail.sources || isRefusal(body)) continue;

    for (const check of await checkCitations(body, detail.sources)) {
      const source = detail.sources.find((candidate) => candidate.number === check.number);
      if (source && check.score !== null) {
        pairs.push({ questionId: detail.id, number: check.number, sentence: check.sentence, chunks: source.chunks, score: check.score });
      }
    }
  }

  if (pairs.length === 0) throw new Error(`${run.file} has no scored citations (saved before the citation check?).`);

  pairs.sort((a, b) => a.score - b.score);
  const chosen = new Set(pairs.filter((pair) => include.includes(pair.questionId)));
  // The weakest pairs are the likeliest to be unsupported: take them first.
  for (const pair of pairs.slice(0, 8)) if (chosen.size < REAL_PAIRS) chosen.add(pair);
  // Then pairs spread evenly over the whole score range.
  const rest = pairs.filter((pair) => !chosen.has(pair));
  const wanted = Math.max(REAL_PAIRS - chosen.size, 0);
  for (let i = 0; i < wanted && rest.length > 0; i++) {
    chosen.add(rest[Math.floor(((i + 0.5) / wanted) * rest.length)]!);
  }

  const real = [...chosen].sort((a, b) => a.score - b.score);
  const labels: Label[] = real.map((pair) => ({
    id: `${pair.questionId}#${pair.number}`,
    kind: "real",
    sentence: pair.sentence,
    chunks: pair.chunks,
    supported: null,
  }));

  // Mismatched: a sentence against the source of a question about another file.
  for (let i = 0; i < MISMATCHED_PAIRS; i++) {
    const pair = real[Math.floor(((i + 0.5) / MISMATCHED_PAIRS) * real.length)]!;
    const other = pairs.find(
      (candidate, index) =>
        index >= Math.floor(((i + 0.5) / MISMATCHED_PAIRS) * pairs.length) &&
        fileOf.get(candidate.questionId) !== fileOf.get(pair.questionId),
    ) ?? pairs.find((candidate) => fileOf.get(candidate.questionId) !== fileOf.get(pair.questionId));
    if (!other) continue;

    labels.push({
      id: `${pair.questionId}#${pair.number}x${other.questionId}#${other.number}`,
      kind: "mismatched",
      sentence: pair.sentence,
      chunks: other.chunks,
      supported: false,
      note: "Sentence and source come from different documents.",
    });
  }

  await writeFile(LABELS_FILE, JSON.stringify(labels, null, 2) + "\n");
  console.log(
    `Wrote ${labels.length} pairs from ${run.file} to ${LABELS_FILE} ` +
      `(${real.length} real, ${labels.length - real.length} mismatched). ` +
      `Set "supported" to true or false on each real pair, then run npm run eval:citations.`,
  );
}

async function calibrate(): Promise<void> {
  const labels = JSON.parse(await readFile(LABELS_FILE, "utf-8")) as Label[];
  const unlabelled = labels.filter((label) => label.supported === null);
  if (unlabelled.length > 0) {
    console.warn(`${unlabelled.length} pairs have no label yet and are skipped: ${unlabelled.map((l) => l.id).join(", ")}`);
  }

  const scored: { id: string; kind: string; supported: boolean; score: number; sentence: string }[] = [];

  for (const label of labels) {
    if (label.supported === null) continue;
    const score = await supportScore(label.sentence, label.chunks);
    if (score === null) throw new Error("The reranker is off or down; the pairs cannot be scored.");
    scored.push({ id: label.id, kind: label.kind, supported: label.supported, score, sentence: label.sentence });
  }

  scored.sort((a, b) => b.score - a.score);
  console.table(
    scored.map((pair) => ({
      id: pair.id.slice(0, 44),
      kind: pair.kind,
      supported: pair.supported ? "yes" : "NO",
      score: pair.score.toFixed(2),
      sentence: pair.sentence.slice(0, 60),
    })),
  );

  const range = (values: number[]) =>
    values.length === 0 ? "-" : `${Math.min(...values).toFixed(2)} .. ${Math.max(...values).toFixed(2)}`;
  const group = (test: (pair: (typeof scored)[number]) => boolean) => scored.filter(test).map((pair) => pair.score);
  const report = (name: string, pairs: typeof scored) => {
    const result = separation(pairs);
    console.log(
      `${name} (${pairs.length} pairs): separation (AUC) ${result.auc.toFixed(2)}; best cut-off ${result.threshold.toFixed(2)} ` +
        `gets ${Math.round(result.accuracy * 100)}% right ` +
        `(${result.falsePositives} unsupported accepted, ${result.falseNegatives} supported rejected)`,
    );
    return result;
  };

  console.log(
    `\nScores: supported ${range(group((p) => p.supported))}, ` +
      `unsupported from answers ${range(group((p) => !p.supported && p.kind === "real"))}, ` +
      `mismatched ${range(group((p) => p.kind === "mismatched"))}`,
  );
  report("All pairs", scored);
  // The hard part: pairs from real answers only (a mismatched source is easy to reject).
  report("Pairs from answers only", scored.filter((pair) => pair.kind === "real"));

  const current = scored.filter((pair) => pair.score >= CITATION_SUPPORT_SCORE === pair.supported).length;
  console.log(
    `Current cut-off ${CITATION_SUPPORT_SCORE} (CITATION_SUPPORT_SCORE): ${current}/${scored.length} right`,
  );
}

try {
  await (args.includes("--export") ? exportPairs() : calibrate());
} finally {
  await pool.end();
}
