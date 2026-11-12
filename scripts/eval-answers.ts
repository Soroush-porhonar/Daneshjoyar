/**
 * End-to-end answer evaluation: runs the real pipeline (rewrite -> retrieval ->
 * local LLM) and checks the final answers. Slow on CPU (~15-30 s per question).
 *
 *   npm run eval:answers
 *   npm run eval:answers -- --only lisbon
 *   npm run eval:answers -- --no-judge      # skip the LLM-as-judge step
 *   npm run eval:answers -- --doc "x.pdf=12" # pin a document version (before/after)
 *   npm run eval:answers -- --per-doc       # search only each question's own document
 *   npm run eval:answers -- --rescore       # re-check the newest saved run, no model calls
 *   npm run eval:answers -- --rescore eval/results/answers-2026-11-03T01-58-00.json
 *
 * Like the bot, questions search all documents of their document's owner;
 * "cites" needs the right page of the right file.
 *
 * Runs every question in eval/questions.json that has `mustInclude` keywords,
 * plus all `negative` questions. Checks per answer (scripts/answerChecks.ts):
 *   cites     - the sources list contains an expected page
 *   keywords  - every `mustInclude` entry appears in the answer; an entry may
 *               list several accepted forms, and formula markup is ignored
 *   persian   - the answer is mainly Persian (code, formulas and parenthesised
 *               Latin terms are not counted)
 *   refused   - negatives: the bot says it is not in the document (no hallucination)
 *   judge     - a second LLM call grades faithfulness to the retrieved text
 *               (weak evidence: the model grades itself; treat as a hint)
 *
 * --rescore applies today's checks and eval/questions.json to the answers of
 * a saved run, and lists every verdict that changes: the way to prove a change
 * to the checks (or to a label) without paying for the answers again.
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pool } from "../src/db/pool.js";
import { chat } from "../src/llm/ollamaClient.js";
import { NO_RELEVANT_CONTENT_TEXT, SOURCES_HEADING } from "../src/messages.js";
import { scoreAnswer } from "./answerChecks.js";
import type { AnswerQuestion, AnswerScore } from "./answerChecks.js";
import { RESULTS_DIR, previousHits, previousResult, saveResult } from "./evalHelpers.js";
import { answerFromDocuments, formatChunks, numberSources } from "../src/rag/answer.js";
import { rankedCandidates, retrieveContext } from "../src/rag/retrieve.js";
import { rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

interface EvalQuestion extends AnswerQuestion {
  mode: "focused" | "multi_part" | "broad";
  question: string;
  history?: HistoryMessage[];
}

interface Judgement {
  faithful: boolean;
  answersQuestion: boolean;
  reason: string;
}

type Row = Record<string, string | number>;

interface Detail {
  id: string;
  question: string;
  answer: string;
  judgement: Judgement | null;
}

interface SavedRun {
  rows: Row[];
  details: Detail[];
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const useJudge = !args.includes("--no-judge");
/** Search only each question's own document instead of all of its owner's documents. */
const perDocument = args.includes("--per-doc");
const rescoreIndex = args.indexOf("--rescore");
const rescore = rescoreIndex >= 0;
/** --rescore <file>; without a file, the newest saved run. */
const rescoreFile = rescore && !args[rescoreIndex + 1]?.startsWith("--") ? args[rescoreIndex + 1] : undefined;

/** --doc "name.pdf=12": use that document version instead of the newest one. */
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
).filter(
  (q) => (q.mustInclude || q.type === "negative") && (!only || q.id.includes(only)),
);

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    faithful: { type: "boolean" },
    answersQuestion: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["faithful", "answersQuestion", "reason"],
};

async function judge(question: string, sources: string, answer: string): Promise<Judgement> {
  const output = await chat({
    think: false,
    format: JUDGE_SCHEMA,
    options: { temperature: 0, num_predict: 200 },
    messages: [
      {
        role: "system",
        content:
          "You are a strict grader of a study assistant. " +
          "faithful = every fact in the ANSWER is supported by the SOURCES (saying the sources do not cover something is faithful). " +
          "answersQuestion = the ANSWER actually answers the QUESTION; when the SOURCES do not contain the answer, " +
          "clearly saying so is the correct answer and counts as true. " +
          "Numbers like [2] in the ANSWER cite the numbered SOURCES. " +
          "reason = one short English sentence.",
      },
      {
        role: "user",
        content: `SOURCES:\n${sources}\n\nQUESTION:\n${question}\n\nANSWER:\n${answer}`,
      },
    ],
  });
  return JSON.parse(output) as Judgement;
}

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

const yesNo = (value: boolean | null) => (value === null ? "" : value ? "yes" : "NO");

function toRow(q: EvalQuestion, score: AnswerScore, judgement: Judgement | null, seconds: number): Row {
  const negative = q.type === "negative";

  return {
    id: q.id,
    type: q.type,
    cites: yesNo(score.cites),
    // Did the model cite [n] inline? (If not, the bot lists every hit instead.)
    inline: yesNo(score.inline),
    keywords: negative ? "" : score.missing.length === 0 ? "yes" : `NO (${score.missing.join(", ")})`,
    persian: `${Math.round(score.persian * 100)}%`,
    refused: negative ? yesNo(score.refused) : "",
    faithful: judgement ? yesNo(judgement.faithful) : "-",
    answers: judgement ? yesNo(judgement.answersQuestion) : "-",
    pass: score.passed ? "PASS" : "FAIL",
    s: Math.round(seconds),
  };
}

/** The table, every failed answer in full, and the totals. */
function report(rows: Row[], details: Detail[]): void {
  console.table(rows);

  for (const detail of details.filter((_, i) => rows[i]!.pass === "FAIL")) {
    console.log(`\n--- ${detail.id} ---\n${detail.question}\n\n${detail.answer}`);
    if (detail.judgement) console.log("judge:", detail.judgement);
  }

  const count = (key: string, value: string) => rows.filter((r) => r[key] === value).length;
  const positives = rows.filter((r) => r.type !== "negative").length;
  const negatives = rows.length - positives;
  const judged = rows.filter((r) => r.faithful !== "-").length;

  console.log(
    `\npassed ${count("pass", "PASS")}/${rows.length}  ` +
      `cites ${count("cites", "yes")}/${positives}  ` +
      `inline [n] ${count("inline", "yes")}/${count("inline", "yes") + count("inline", "NO")}  ` +
      `keywords ${count("keywords", "yes")}/${positives}  ` +
      `refused negatives ${count("refused", "yes")}/${negatives}  ` +
      `judge faithful ${count("faithful", "yes")}/${judged}  ` +
      `judge answers ${count("answers", "yes")}/${judged}  ` +
      `avg ${Math.round(rows.reduce((s, r) => s + (r.s as number), 0) / Math.max(rows.length, 1))}s`,
  );
}

const rows: Row[] = [];
const details: Detail[] = [];

if (rescore) {
  const saved = rescoreFile
    ? { file: rescoreFile, data: JSON.parse(await readFile(rescoreFile, "utf-8")) as SavedRun }
    : await previousResult<SavedRun>("answers");

  if (!saved) throw new Error(`No saved answers run in ${RESULTS_DIR}`);

  const byId = new Map(questions.map((q) => [q.id, q]));
  const changes: string[] = [];

  saved.data.details.forEach((detail, index) => {
    const q = byId.get(detail.id);
    const old = saved.data.rows[index]!;
    // A question that was removed, lost its keywords, or is filtered out by --only.
    if (!q) return;

    const row = toRow(q, scoreAnswer(q, detail.answer), detail.judgement, Number(old.s));
    rows.push(row);
    details.push(detail);

    if (row.pass !== old.pass) {
      const before = ["cites", "keywords", "persian", "refused"].map((key) => `${key} ${old[key] || "-"}`).join(", ");
      changes.push(`${old.pass} -> ${row.pass}  ${q.id}  (was: ${before})`);
    }
  });

  report(rows, details);
  console.log(`\nRe-scored ${saved.file} (${rows.length} answers); verdicts that changed:`);
  console.log(changes.length > 0 ? changes.join("\n") : "none");

  await pool.end();
  process.exit(0);
}

for (const q of questions) {
  const document = await findDocument(q.filename);
  if (!document) {
    console.warn(`Skipping ${q.id}: no completed document named ${q.filename}`);
    continue;
  }

  console.log(`... ${q.id}`);
  const start = performance.now();
  const question = q.history ? await rewriteQuestion(q.question, q.history) : q.question;
  const mode = q.mode;
  // Like the bot: all of the user's documents, unless --per-doc.
  const scope = perDocument ? { documentId: document.id } : {};
  // Like production: a follow-up's search also reranks the previous answer's hits.
  const include = q.history ? await previousHits(document, q.history, scope.documentId) : [];
  const ranked =
    include.length > 0
      ? await rankedCandidates(document.user_id, question, { ...scope, include })
      : undefined;
  const answer = await answerFromDocuments(document.user_id, question, mode, {
    ...scope,
    ...(ranked ? { prefetch: Promise.resolve({ question, ranked }) } : {}),
  });
  const seconds = (performance.now() - start) / 1000;

  let judgement: Judgement | null = null;
  if (useJudge && answer !== NO_RELEVANT_CONTENT_TEXT && mode !== "broad") {
    const context = await retrieveContext(
      document.user_id,
      question,
      mode === "multi_part" ? "multi_part" : "focused",
      { ...scope, ...(ranked ? { ranked } : {}) },
    );
    const body = answer.split(SOURCES_HEADING)[0]!;
    judgement = await judge(question, formatChunks(context, numberSources(context)), body).catch(() => null);
  }

  rows.push(toRow(q, scoreAnswer(q, answer), judgement, seconds));
  details.push({ id: q.id, question, answer, judgement });
}

report(rows, details);
console.log(`Saved ${await saveResult("answers", { rows, details })}`);

await pool.end();
