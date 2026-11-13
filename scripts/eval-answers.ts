/**
 * End-to-end answer evaluation: runs the real pipeline (rewrite -> retrieval ->
 * local LLM) and checks the final answers. Slow on CPU (~15-30 s per question).
 *
 *   npm run eval:answers
 *   npm run eval:answers -- --only lisbon
 *   npm run eval:answers -- --doc "x.pdf=12" # pin a document version (before/after)
 *   npm run eval:answers -- --per-doc       # search only each question's own document
 *   npm run eval:answers -- --rescore       # re-check the newest saved run, no model calls
 *   npm run eval:answers -- --rescore eval/results/answers-2026-11-03T01-58-00.json
 *   npm run eval:answers -- --rescore --judge   # also judge every cited sentence (scripts/judge.ts, CPU, ~30 s per sentence)
 *   npm run eval:answers -- --rescore --judge --reuse-judged  # keep the newest judge run's single-source verdicts
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
 *   judge     - with --rescore --judge, gpt-oss:20b (scripts/judge.ts) checks
 *               every cited sentence against its source, fact by fact.
 *               Calibrated on 30 labelled pairs: 26/30 right, 5/6 unsupported
 *               caught, 3/16 supported claims wrongly rejected, so the number
 *               is a slight underestimate. Reported, not part of pass/fail.
 *               (Qwen grading its own answers was dropped: it passed a wrong
 *               refusal and failed correct ones.)
 *
 * --rescore applies today's checks and eval/questions.json to the answers of
 * a saved run, and lists every verdict that changes: the way to prove a change
 * to the checks (or to a label) without paying for the answers again.
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pool } from "../src/db/pool.js";
import { NO_RELEVANT_CONTENT_TEXT, SOURCES_HEADING } from "../src/messages.js";
import { coversPage, scoreAnswer } from "./answerChecks.js";
import type { AnswerQuestion, AnswerScore } from "./answerChecks.js";
import { CITATION_SUPPORT_SCORE, checkCitations, isSupported, numberedSources } from "./citationCheck.js";
import { JUDGE_MODEL, judgeClaims, unloadAnswerModel } from "./judge.js";
import type { CitationCheck, NumberedSource } from "./citationCheck.js";
import { RESULTS_DIR, evalUser, previousHits, previousResult, saveResult } from "./evalHelpers.js";
import { answerFromDocuments, isRefusal } from "../src/rag/answer.js";
import type { AnswerTrace } from "../src/rag/answer.js";
import { answerDocumentInfo } from "../src/rag/documentInfo.js";
import { rankedCandidates } from "../src/rag/retrieve.js";
import { needsRewrite, rewriteQuestion } from "../src/rag/rewrite.js";
import { routeMessage } from "../src/rag/router.js";
import { answerTransform, isTransformRequest } from "../src/rag/transform.js";
import { listCompletedFilenames } from "../src/db/documents.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

interface EvalQuestion extends AnswerQuestion {
  mode: "focused" | "multi_part" | "broad";
  question: string;
  history?: HistoryMessage[];
  tags?: string[];
}

type Row = Record<string, string | number>;

interface Detail {
  id: string;
  question: string;
  answer: string;
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
/** Judge the cited sentences of a saved run (only with --rescore: the judge and Qwen must not share a run). */
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
/** What the router sees, as in the bot. */
const documentNames = await listCompletedFilenames(evalUserId);

const nearMissIds = new Set(questions.filter((q) => q.tags?.includes("near_miss")).map((q) => q.id));

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
  const judged = (detail.citations ?? []).filter((check) => typeof check.judged === "boolean");
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
    // Every judged claim of the answer supported by its source.
    faithful: judged.length === 0 ? "-" : yesNo(judged.every((check) => check.judged)),
    pass: score.passed && !wrongRefusal(detail) ? "PASS" : "FAIL",
    s: Math.round(seconds),
  };
}

/** The table, every failed answer in full, and the totals. */
function report(rows: Row[], details: Detail[]): void {
  console.table(rows);

  for (const detail of details.filter((_, i) => rows[i]!.pass === "FAIL")) {
    console.log(`\n--- ${detail.id} ---\n${detail.question}\n\n${detail.answer}`);
  }

  const count = (key: string, value: string) => rows.filter((r) => r[key] === value).length;
  const positives = rows.filter((r) => r.type !== "negative").length;
  const negatives = rows.length - positives;
  const judged = rows.filter((r) => r.faithful !== "-").length;
  // One verdict per cited sentence (a sentence citing [1][2] is judged against both together).
  const sentences = details.flatMap((detail) =>
    citedSentenceGroups(detail).map((group) => ({ id: detail.id, numbers: group.map((c) => c.number), ...group[0]! })),
  );
  const judgedSentences = sentences.filter((sentence) => typeof sentence.judged === "boolean");

  const rejected = judgedSentences.filter((sentence) => !sentence.judged);
  if (rejected.length > 0) {
    console.log("\nSentences the judge found unsupported by their cited sources:");
    for (const sentence of rejected) {
      console.log(
        `  ${sentence.id} [${sentence.numbers.join("][")}] ${sentence.sentence.slice(0, 120)}\n      ${sentence.judgeReason ?? ""}`,
      );
    }
  }

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
        ? `judge: sentences supported ${judgedSentences.length - rejected.length}/${judgedSentences.length}, answers faithful ${count("faithful", "yes")}/${judged}  `
        : "") +
      `avg ${Math.round(rows.reduce((s, r) => s + (r.s as number), 0) / Math.max(rows.length, 1))}s`,
  );
}

const rows: Row[] = [];
const details: Detail[] = [];

if (useJudge && !rescore) {
  throw new Error("--judge works on a saved run: npm run eval:answers -- --rescore --judge");
}

/** An answer's citations grouped by sentence, in order. */
function citedSentenceGroups(detail: Detail): CitationCheck[][] {
  const groups = new Map<string, CitationCheck[]>();
  for (const check of detail.citations ?? []) {
    const group = groups.get(check.sentence) ?? [];
    group.push(check);
    groups.set(check.sentence, group);
  }
  return [...groups.values()];
}

/**
 * --reuse-judged: verdicts on single-source sentences from the newest judge run
 * (the same sentence and source put the same question to the judge).
 */
const reusable = new Map<string, CitationCheck>();
if (useJudge && args.includes("--reuse-judged")) {
  const previous = await previousResult<SavedRun>("judge");
  for (const detail of previous?.data.details ?? []) {
    for (const group of citedSentenceGroups(detail)) {
      const check = group[0]!;
      if (group.length === 1 && typeof check.judged === "boolean") {
        reusable.set(`${detail.id}|${check.number}|${check.sentence}`, check);
      }
    }
  }
}

/**
 * The judge's verdict on each cited sentence of an answer, against all the
 * sources that sentence cites together; one call per sentence, null when it fails.
 */
async function judgeCitations(detail: Detail): Promise<void> {
  for (const group of citedSentenceGroups(detail)) {
    const sentence = group[0]!.sentence;
    const setAll = (judged: boolean | null, reason?: string) =>
      group.forEach((check) => {
        check.judged = judged;
        if (reason !== undefined) check.judgeReason = reason;
      });

    // Citing a source number that was not given is unsupported without asking.
    if (group.some((check) => !check.known)) {
      setAll(false, "cites a source number that was not given");
      continue;
    }
    const reused = group.length === 1 ? reusable.get(`${detail.id}|${group[0]!.number}|${sentence}`) : undefined;
    if (reused) {
      setAll(reused.judged ?? null, reused.judgeReason);
      continue;
    }

    const source = group.flatMap((check) => {
      const chunks = detail.sources!.find((candidate) => candidate.number === check.number)!.chunks;
      return group.length > 1 ? [`Source [${check.number}]:`, ...chunks] : chunks;
    });
    const verdict = await judgeClaims([{ sentence, source }]).catch((error: unknown) => {
      console.warn(`\nJudge failed on ${detail.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    setAll(verdict ? verdict[0]!.supported : null, verdict?.[0]!.reason);
  }
}

if (rescore) {
  if (useJudge) await unloadAnswerModel();
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
    if (useJudge) {
      await judgeCitations(detail);
      process.stdout.write(".");
    }
    const row = toRow(q, scoreAnswer(q, detail.answer), detail, Number(old.s));
    rows.push(row);
    details.push(detail);

    if (row.pass !== old.pass) {
      const before = ["cites", "keywords", "persian", "refused", "refusal"].map((key) => `${key} ${old[key] || "-"}`).join(", ");
      changes.push(`${old.pass} -> ${row.pass}  ${q.id}  (was: ${before})`);
    }
  }

  if (useJudge) console.log();
  report(rows, details);
  if (useJudge && !only) console.log(`Saved ${await saveResult("judge", { source: saved.file, judge: JUDGE_MODEL, rows, details })}`);
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
  // Like the bot: "shorter" after an answer reshapes it; otherwise, after an
  // earlier exchange, the router decides whether the message is a follow-up
  // (the length rule only when it gives no decision).
  const previousReply = q.history?.at(-1);
  const transform = previousReply?.role === "assistant" && isTransformRequest(q.question);
  const routed =
    q.history?.length && !transform ? await routeMessage(q.question, documentNames, q.history).catch(() => null) : null;
  const followUp = q.history !== undefined && !transform && (routed?.dependsOnHistory ?? needsRewrite(q.question, q.history));
  const question = followUp
    ? (routed?.standaloneQuestion ?? (await rewriteQuestion(q.question, q.history!, undefined, true)))
    : q.question;
  const mode = q.mode;
  // Like the bot: all of the user's documents, unless --per-doc.
  const scope = perDocument ? { documentId: document.id } : {};
  // Like production: a follow-up's search also reranks the previous answer's hits,
  // and a transform request is answered from them.
  const include = followUp || transform ? await previousHits(document, q.history!, scope.documentId) : [];
  const ranked =
    followUp && include.length > 0
      ? await rankedCandidates(document.user_id, question, { ...scope, include })
      : undefined;
  // The trace holds the chunks the model was really given (none for a whole-document summary).
  const trace: AnswerTrace = {};
  // A question about the file itself goes to its own route, pinned to that file
  // ("this handout" names no file; the student means this one).
  const answer = transform
    ? await answerTransform(document.user_id, q.question, previousReply!.content, include, { trace })
    : q.route === "document_info"
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

  const detail: Detail = {
    id: q.id,
    question,
    answer,
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
