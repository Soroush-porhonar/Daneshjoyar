/**
 * One queue for the GPU (roadmap Q1, Q2). Ollama serves one chat at a time;
 * before this, every call went straight to it, so with 5 students at once
 * the last waited 51 s, timed out from the moment it was sent, and nobody
 * knew why. Now every chat call (ollamaClient.chat) takes the GPU here:
 *
 * - "answer" jobs (a student's question) go first, oldest question first, so
 *   a question that has started (router done) finishes before the next one;
 * - "ocr" jobs (reading an upload) run when no answer is waiting;
 * - "enrich" jobs (background) run only when no question is being answered at
 *   all, so they never slip between a student's router call and answer call.
 *
 * Long jobs give way between calls: OCR is one call per strip, summaries one
 * per batch. Embeddings and the reranker are not on this GPU queue (short
 * calls, another model; the reranker runs on the CPU).
 *
 * Which kind a call is comes from the context it runs in (runAs), so the
 * code between a student's message and the model call does not pass it on.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type JobKind = "answer" | "ocr" | "enrich";

export interface JobContext {
  kind: JobKind;
  /** Told the student's place among waiting questions (1 = next), and 0 when the job starts. */
  onPosition?: (place: number) => void;
  /** Milliseconds this context's calls spent waiting for the GPU (filled in here). */
  waitedMs?: number;
}

interface Waiter {
  context: JobContext;
  /** Orders answers: when the question started (earlier first). */
  order: number;
  enqueuedAt: number;
  start: () => void;
}

const storage = new AsyncLocalStorage<JobContext & { order: number }>();
let nextOrder = 0;
let busy = false;
let waiting: Waiter[] = [];
let activeQuestions = 0;
const lastPlace = new WeakMap<JobContext, number>();

/** Runs `work` with its model calls queued as `context.kind`. */
export function runAs<T>(context: JobContext, work: () => Promise<T>): Promise<T> {
  return storage.run(Object.assign(context, { order: nextOrder++ }), work);
}

/**
 * Marks a question as being answered (the busy limit counts these, and
 * enrichment waits until none are left); call the result when it is done.
 */
export function startQuestion(): () => void {
  activeQuestions++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    activeQuestions--;
    if (activeQuestions === 0) {
      const ready = idleWaiters;
      idleWaiters = [];
      ready.forEach((resolve) => resolve());
    }
    pump();
  };
}

let idleWaiters: (() => void)[] = [];

/** Resolves when no question is being answered (enrichment's embedding batches wait for this). */
export function questionsIdle(): Promise<void> {
  return activeQuestions === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
}

/** Questions being answered now, waiting or on the GPU. */
export const activeQuestionCount = (): number => activeQuestions;

const rank: Record<JobKind, number> = { answer: 0, ocr: 1, enrich: 2 };

/** The next waiter allowed on the GPU, or undefined. */
function pick(): Waiter | undefined {
  const sorted = [...waiting].sort(
    (a, b) => rank[a.context.kind] - rank[b.context.kind] || a.order - b.order || a.enqueuedAt - b.enqueuedAt,
  );
  const next = sorted[0];
  if (next?.context.kind === "enrich" && activeQuestions > 0) return undefined;
  return next;
}

/** Tells each waiting question its place, when it changed. */
function announcePlaces(): void {
  const answers = waiting
    .filter((waiter) => waiter.context.kind === "answer")
    .sort((a, b) => a.order - b.order || a.enqueuedAt - b.enqueuedAt);
  answers.forEach((waiter, index) => {
    const place = index + 1;
    if (lastPlace.get(waiter.context) !== place) {
      lastPlace.set(waiter.context, place);
      waiter.context.onPosition?.(place);
    }
  });
}

function pump(): void {
  if (busy) return;
  const next = pick();
  if (!next) return;
  waiting = waiting.filter((waiter) => waiter !== next);
  busy = true;
  next.start();
  announcePlaces();
}

function release(): void {
  busy = false;
  pump();
}

/**
 * Runs `run` when the GPU is free for this context's kind (default: an
 * answer, as for eval scripts). Waiting can be aborted with `signal`; the
 * time spent waiting is added to the context's `waitedMs`.
 */
export async function onGpu<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const context = storage.getStore() ?? { kind: "answer" as const, order: nextOrder++ };
  const enqueuedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      context,
      order: context.order,
      enqueuedAt,
      start: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
    };
    const onAbort = () => {
      waiting = waiting.filter((other) => other !== waiter);
      announcePlaces();
      reject(signal!.reason instanceof Error ? signal!.reason : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(waiter);
    pump();
    // Not started at once: say where it stands.
    if (waiting.includes(waiter)) announcePlaces();
  });

  const waitedMs = Date.now() - enqueuedAt;
  context.waitedMs = (context.waitedMs ?? 0) + waitedMs;
  if (lastPlace.get(context)) {
    lastPlace.set(context, 0);
    context.onPosition?.(0);
  }

  try {
    return await run();
  } finally {
    release();
  }
}

/** For tests: forget all state. */
export function resetScheduler(): void {
  busy = false;
  waiting = [];
  activeQuestions = 0;
  nextOrder = 0;
  idleWaiters = [];
}
