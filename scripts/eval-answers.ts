/**
 * End-to-end answer evaluation: runs the real pipeline (rewrite -> retrieval ->
 * local LLM) and checks the final answers. Slow on CPU (~15-30 s per question).
 *
 *   npm run eval:answers
 *   npm run eval:answers -- --only lisbon
 *   npm run eval:answers -- --judge         # also ask the LLM to grade each answer (off by default)
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
 *   context   - the expected page was among the sources the model was given
 *   refusal   - WRONG when the answer says the notes don't cover the question
 *               although the expected page was in its sources (a failure the
 *               judge could not see)
 *   citations - how many of the answer's "[n]" citations point to a source on
 *               the same topic, scored by the cross-encoder
 *               (scripts/citationCheck.ts). A topic check only: measured, it
 *               cannot tell a supported claim from an invented one. Reported,
 *               not part of pass/fail.
 *   judge     - with --judge, a second LLM call grades faithfulness. Weak
 *               evidence: the model grades itself (it once passed all 54
 *               answers including a wrong refusal, then failed 4 correct
 *               refusals), so it is off by default.
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
import { coversPage, scoreAnswer } from "./answerChecks.js";
import type { AnswerQuestion, AnswerScore } from "./answerChecks.js";
import { CITATION_SUPPORT_SCORE, checkCitations, isSupported, numberedSources } from "./citationCheck.js";
import type { CitationCheck, NumberedSource } from "./citationCheck.js";
import { RESULTS_DIR, evalUser, previousHits, previousResult, saveResult } from "./evalHelpers.js";
import { answerFromDocuments, formatChunks, isRefusal, numberSources } from "../src/rag/answer.js";
import type { AnswerTrace } from "../src/rag/answer.js";
import { answerDocumentInfo } from "../src/rag/documentInfo.js";
import { rankedCandidates } from "../src/rag/retrieve.js";
import { rewriteQuestion } from "../src/rag/rewrite.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

interface EvalQuestion extends AnswerQuestion {
  mode: "focused" | "multi_part" | "broad";
  question: string;
  history?: HistoryMessage[];
  tags?: string[];
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
  /**
   * Was an expected page among the sources? Null for unanswerable questions
   * and whole-document summaries; missing in runs saved before the citation check.
   */
  inContext?: boolean | null;
  /** The numbered sources the model was given. */
  sources?: NumberedSource[];
  /** Each "[n]" of the answer, scored against its source. */
  citations?: CitationCheck[];
}

interface SavedRun {
  rows: Row[];
  details: Detail[];
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
/** The LLM judge is opt-in (--no-judge is still accepted and changes nothing). */
const useJudge = args.includes("--judge");
/** Search only each question's own document instead of all of its owner's documents. */
const perDocument = args.includes("--per-doc");
const rescoreIndex = args.indexOf("--rescore");
const rescore = rescoreIndex >= 0;
/** --rescore <file>; without a file, the newest saved run. */
const rescoreFile = rescore && !args[rescoreIndex + 1]?.startsWith("--") ? args[rescoreIndex + 1] : undefined;

/**
 * --user 42: use that user's copies of the eval documents (the distractor run: the
 * eval PDFs ingested with many other documents under a separate user).
 */

/** --doc "name.pdf=12": use that document version instead of the newest one. */
const pinned = new Map(
  args
    .flatMap((arg, i) => (args[i - 1] === "--doc" ? [arg] : []))
    .map((pair) => {
      const at = pair.lastIndexOf("=");
      return [pair.slice(0, at), Number(pair.slice(at + 1))] as const;
    }),
);

const allQuestions = JSON.parse(await readFile("eval/questions.json", "utf-8")) as EvalQuestion[];
const questions = allQuestions.filter(
  (q) => (q.mustInclude || q.type === "negative") && (!only || q.id.includes(only)),
);
/** Whose copies of the eval documents are used (--user 42 for the distractor run). */
const evalUserId = await evalUser(args, allQuestions.map((q) => q.filename));

const nearMissIds = new Set(questions.filter((q) => q.tags?.includes("near_miss")).map((q) => q.id));

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
       AND ($3::integer IS NULL OR user_id = $3)
     ORDER BY id DESC LIMIT 1`,
    [filename, pinned.get(filename) ?? null, evalUserId],
  );
  return found.rows[0];
}

const yesNo = (value: boolean | null) => (value === null ? "" : value ? "yes" : "NO");

/** The answer says the notes don't cover it, although it was given the page that does. */
const wrongRefusal = (detail: Detail) =>
  detail.inContext === true && isRefusal(detail.answer.split(SOURCES_HEADING)[0]!.trim());

/**
 * The answer's citations, each scored against its source. None for a
 * whole-document summary (its sources are pages, not the text it saw) and
 * none for a refusal: "the sources only cover X [1]" is not a claim about the notes.
 */
async function citationsOf(answer: string, sources: NumberedSource[], mode: EvalQuestion["mode"]): Promise<CitationCheck[]> {
  const body = answer.split(SOURCES_HEADING)[0]!.trim();
  if (mode === "broad" || answer === NO_RELEVANT_CONTENT_TEXT || isRefusal(body)) return [];
  return checkCitations(body, sources);
}

/** Supported and scored citations of an answer. */
function citationCounts(detail: Detail): { supported: number; scored: number } {
  const verdicts = (detail.citations ?? []).map((check) => isSupported(check)).filter((verdict) => verdict !== null);
  return { supported: verdicts.filter(Boolean).length, scored: verdicts.length };
}

function toRow(q: EvalQuestion, score: AnswerScore, detail: Detail, seconds: number): Row {
  const negative = q.type === "negative";
  const { judgement } = detail;
  const { supported, scored } = citationCounts(detail);

  return {
    id: q.id,
    type: q.type,
    context: yesNo(detail.inContext ?? null),
    cites: yesNo(score.cites),
    // Did the model cite [n] inline? (If not, the bot lists every hit instead.)
    inline: yesNo(score.inline),
    keywords: negative ? "" : score.missing.length === 0 ? "yes" : `NO (${score.missing.join(", ")})`,
    persian: `${Math.round(score.persian * 100)}%`,
    refused: negative ? yesNo(score.refused) : "",
    refusal: wrongRefusal(detail) ? "WRONG" : "",
    citations: scored === 0 ? "" : `${supported}/${scored}`,
    faithful: judgement ? yesNo(judgement.faithful) : "-",
    answers: judgement ? yesNo(judgement.answersQuestion) : "-",
    pass: score.passed && !wrongRefusal(detail) ? "PASS" : "FAIL",
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

  // Every citation to an off-topic source, weakest first: read these.
  const unsupported = details
    .flatMap((detail) => (detail.citations ?? []).map((check) => ({ id: detail.id, ...check })))
    .filter((check) => isSupported(check) === false)
    .sort((a, b) => (a.score ?? -Infinity) - (b.score ?? -Infinity));

  if (unsupported.length > 0) {
    console.log(`\nCitations to a source about something else (score below ${CITATION_SUPPORT_SCORE}):`);
    for (const check of unsupported) {
      console.log(
        `  ${check.id} [${check.number}] ${check.known ? check.score!.toFixed(2) : "no such source"}  ${check.sentence.slice(0, 140)}`,
      );
    }
  }

  const totals = details.map(citationCounts);
  const supported = totals.reduce((sum, t) => sum + t.supported, 0);
  const scored = totals.reduce((sum, t) => sum + t.scored, 0);
  const withContext = details.filter((detail) => typeof detail.inContext === "boolean");
  // Unanswerable questions whose topic is in the notes but whose fact is not: the hard refusals.
  const nearMiss = rows.filter((row) => nearMissIds.has(String(row.id)));

  console.log(
    `\npassed ${count("pass", "PASS")}/${rows.length}  ` +
      (withContext.length > 0
        ? `page in context ${withContext.filter((detail) => detail.inContext).length}/${withContext.length}  ` +
          `wrong refusals ${count("refusal", "WRONG")}  `
        : "") +
      (scored > 0 ? `citations on topic ${supported}/${scored} (${Math.round((supported / scored) * 100)}%)  ` : "") +
      `cites ${count("cites", "yes")}/${count("cites", "yes") + count("cites", "NO")}  ` +
      `inline [n] ${count("inline", "yes")}/${count("inline", "yes") + count("inline", "NO")}  ` +
      `keywords ${count("keywords", "yes")}/${positives}  ` +
      `refused negatives ${count("refused", "yes")}/${negatives}  ` +
      (nearMiss.length > 0
        ? `of them near-miss ${nearMiss.filter((row) => row.refused === "yes").length}/${nearMiss.length}  `
        : "") +
      (judged > 0
        ? `judge faithful ${count("faithful", "yes")}/${judged}  judge answers ${count("answers", "yes")}/${judged}  `
        : "") +
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

  for (const [index, saved_] of saved.data.details.entries()) {
    const q = byId.get(saved_.id);
    const old = saved.data.rows[index]!;
    // A question that was removed, lost its keywords, or is filtered out by --only.
    if (!q) continue;

    // Runs saved with their sources: check the citations again with today's rules.
    const detail: Detail = saved_.sources
      ? { ...saved_, citations: await citationsOf(saved_.answer, saved_.sources, q.mode) }
      : saved_;
    const row = toRow(q, scoreAnswer(q, detail.answer), detail, Number(old.s));
    rows.push(row);
    details.push(detail);

    if (row.pass !== old.pass) {
      const before = ["cites", "keywords", "persian", "refused", "refusal"].map((key) => `${key} ${old[key] || "-"}`).join(", ");
      changes.push(`${old.pass} -> ${row.pass}  ${q.id}  (was: ${before})`);
    }
  }

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
  // The trace holds the chunks the model was really given (none for a whole-document summary).
  const trace: AnswerTrace = {};
  // A question about the file itself goes to its own route, pinned to that file
  // ("this handout" names no file; the student means this one).
  const answer =
    q.route === "document_info"
      ? await answerDocumentInfo(document.user_id, question, { documentId: document.id, trace })
      : await answerFromDocuments(document.user_id, question, mode, {
          ...scope,
          ...(ranked ? { prefetch: Promise.resolve({ question, ranked }) } : {}),
          trace,
        });
  const seconds = (performance.now() - start) / 1000;

  const context = trace.context ?? [];
  const body = answer.split(SOURCES_HEADING)[0]!;
  const sources = numberedSources(context);
  const focused = mode !== "broad";

  let judgement: Judgement | null = null;
  if (useJudge && answer !== NO_RELEVANT_CONTENT_TEXT && focused) {
    judgement = await judge(question, formatChunks(context, numberSources(context)), body).catch(() => null);
  }

  const detail: Detail = {
    id: q.id,
    question,
    answer,
    judgement,
    inContext: q.type === "negative" || !focused ? null : coversPage(context, document.id, q.expectedPages),
    sources,
    citations: await citationsOf(answer, sources, mode),
  };

  rows.push(toRow(q, scoreAnswer(q, answer), detail, seconds));
  details.push(detail);
}

report(rows, details);
// A partial run (--only) is not saved: --rescore and eval:citations read the newest run.
if (!only) console.log(`Saved ${await saveResult("answers", { rows, details })}`);

await pool.end();
