/**
 * End-to-end answer evaluation: runs the real pipeline (rewrite -> retrieval ->
 * local LLM) and checks the final answers. Slow on CPU (~15-30 s per question).
 *
 *   npm run eval:answers
 *   npm run eval:answers -- --only lisbon
 *   npm run eval:answers -- --no-judge      # skip the LLM-as-judge step
 *   npm run eval:answers -- --doc "x.pdf=12" # pin a document version (before/after)
 *
 * Runs every question in eval/questions.json that has `mustInclude` keywords,
 * plus all `negative` questions. Checks per answer:
 *   cites     - the sources list contains an expected page
 *   keywords  - every `mustInclude` keyword appears in the answer
 *   persian   - the answer is mainly Persian
 *   refused   - negatives: the bot says it is not in the document (no hallucination)
 *   judge     - a second LLM call grades faithfulness to the retrieved text
 *               (weak evidence: the model grades itself; treat as a hint)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pool } from "../src/db/pool.js";
import { chat } from "../src/llm/ollamaClient.js";
import { NO_RELEVANT_CONTENT_TEXT, SOURCES_HEADING } from "../src/messages.js";
import { previousHits } from "./evalHelpers.js";
import {
  REFUSAL_PATTERN,
  answerFromDocument,
  citedNumbers,
  formatChunks,
  numberSources,
} from "../src/rag/answer.js";
import { rankedCandidates, retrieveContext } from "../src/rag/retrieve.js";
import { rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";
import { normalizeText } from "../src/rag/textQuality.js";

interface EvalQuestion {
  id: string;
  type: string;
  filename: string;
  mode: "focused" | "multi_part" | "broad";
  question: string;
  expectedPages: number[];
  mustInclude?: string[];
  history?: HistoryMessage[];
}

interface Judgement {
  faithful: boolean;
  answersQuestion: boolean;
  reason: string;
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const useJudge = !args.includes("--no-judge");

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

/** Makes keyword matching tolerant of spacing, half-spaces, digits and superscripts. */
function comparable(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/ⁿ/g, "n")
    .replace(/[\s‌^]/g, "");
}

function citedPages(answer: string): number[] {
  const sources = answer.split(SOURCES_HEADING)[1] ?? "";
  // "صفحه 3" or a range "صفحه 3 تا 5" (a chunk crossing pages) -> every page in it.
  return [...sources.matchAll(/صفحه (\d+)(?: تا (\d+))?/g)].flatMap((match) => {
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
}

function persianShare(text: string): number {
  const persian = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return persian / Math.max(persian + latin, 1);
}

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

const rows: Record<string, unknown>[] = [];
const details: Record<string, unknown>[] = [];

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
  // Like production: a follow-up's search also reranks the previous answer's hits.
  const include = q.history ? await previousHits(document, q.history) : [];
  const ranked =
    include.length > 0
      ? await rankedCandidates(document.user_id, question, { documentId: document.id, include })
      : undefined;
  const answer = await answerFromDocument(document.user_id, document.id, question, mode, undefined, ranked);
  const seconds = (performance.now() - start) / 1000;

  const body = answer.split(SOURCES_HEADING)[0]!;
  const negative = q.type === "negative";
  const cites = negative ? null : citedPages(answer).some((p) => q.expectedPages.includes(p));
  const missing = (q.mustInclude ?? []).filter((k) => !comparable(body).includes(comparable(k)));
  const refused = answer === NO_RELEVANT_CONTENT_TEXT || REFUSAL_PATTERN.test(body);

  let judgement: Judgement | null = null;
  if (useJudge && answer !== NO_RELEVANT_CONTENT_TEXT && mode !== "broad") {
    const context = await retrieveContext(
      document.user_id,
      question,
      mode === "multi_part" ? "multi_part" : "focused",
      { documentId: document.id, ...(ranked ? { ranked } : {}) },
    );
    judgement = await judge(question, formatChunks(context, numberSources(context)), body).catch(() => null);
  }

  const passed = negative
    ? refused
    : Boolean(cites) && missing.length === 0 && persianShare(body) >= 0.4;

  rows.push({
    id: q.id,
    type: q.type,
    cites: cites === null ? "" : cites ? "yes" : "NO",
    // Did the model cite [n] inline? (If not, the bot lists every hit instead.)
    inline: negative || refused ? "" : citedNumbers(body).size > 0 ? "yes" : "NO",
    keywords: negative ? "" : missing.length === 0 ? "yes" : `NO (${missing.join(", ")})`,
    persian: `${Math.round(persianShare(body) * 100)}%`,
    refused: negative ? (refused ? "yes" : "NO") : "",
    faithful: judgement ? (judgement.faithful ? "yes" : "NO") : "-",
    answers: judgement ? (judgement.answersQuestion ? "yes" : "NO") : "-",
    pass: passed ? "PASS" : "FAIL",
    s: Math.round(seconds),
  });
  details.push({ id: q.id, question, answer, judgement });
}

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

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
await mkdir("eval/results", { recursive: true });
await writeFile(
  `eval/results/answers-${stamp}.json`,
  JSON.stringify({ date: new Date().toISOString(), rows, details }, null, 2),
);
console.log(`Saved eval/results/answers-${stamp}.json`);

await pool.end();
