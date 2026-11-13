import { beforeEach, describe, expect, it } from "vitest";
import {
  activeQuestionCount,
  onGpu,
  questionsIdle,
  resetScheduler,
  runAs,
  startQuestion,
} from "../src/llm/scheduler.js";
import type { JobContext } from "../src/llm/scheduler.js";

/** A GPU job that runs until released; records when it starts. */
function job(log: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const run = () => {
    log.push(name);
    return done;
  };
  return { run, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetScheduler());

describe("GPU queue", () => {
  it("runs one job at a time", async () => {
    const log: string[] = [];
    const a = job(log, "a");
    const b = job(log, "b");

    const first = onGpu(a.run);
    const second = onGpu(b.run);
    await tick();
    expect(log).toEqual(["a"]);

    a.release();
    await first;
    await tick();
    expect(log).toEqual(["a", "b"]);
    b.release();
    await second;
  });

  it("serves answers before OCR, and OCR before enrichment", async () => {
    const log: string[] = [];
    const busy = job(log, "busy");
    const running = onGpu(busy.run);
    await tick();

    const enrich = job(log, "enrich");
    const ocr = job(log, "ocr");
    const answer = job(log, "answer");
    const waits = [
      runAs({ kind: "enrich" }, () => onGpu(enrich.run)),
      runAs({ kind: "ocr" }, () => onGpu(ocr.run)),
      runAs({ kind: "answer" }, () => onGpu(answer.run)),
    ];

    busy.release();
    await running;
    await tick();
    answer.release();
    await tick();
    ocr.release();
    await tick();
    enrich.release();
    await Promise.all(waits);

    expect(log).toEqual(["busy", "answer", "ocr", "enrich"]);
  });

  it("uses the GPU while a question searches, then finishes the older question first", async () => {
    const log: string[] = [];
    const calls = { olderRouter: job(log, "older router"), newerRouter: job(log, "newer router") };
    const answers = { older: job(log, "older answer"), newer: job(log, "newer answer") };
    const question = (router: ReturnType<typeof job>, answer: ReturnType<typeof job>, search: Promise<void>) =>
      runAs({ kind: "answer" }, async () => {
        await onGpu(router.run);
        await search; // retrieval and rerank: no GPU
        await onGpu(answer.run);
      });

    let searched!: () => void;
    const search = new Promise<void>((resolve) => (searched = resolve));
    const older = question(calls.olderRouter, answers.older, search);
    await tick();
    const newer = question(calls.newerRouter, answers.newer, search);
    await tick();

    // While the older question searches, the newer one's router call takes the GPU.
    calls.olderRouter.release();
    await tick();
    expect(log).toEqual(["older router", "newer router"]);

    // Both now want the GPU for their answers: the older question goes first.
    searched();
    await tick();
    calls.newerRouter.release();
    await tick();
    answers.older.release();
    await tick();
    answers.newer.release();
    await Promise.all([older, newer]);

    expect(log).toEqual(["older router", "newer router", "older answer", "newer answer"]);
  });

  it("holds enrichment while any question is being answered", async () => {
    const log: string[] = [];
    const finished = startQuestion();
    const enrich = job(log, "enrich");
    const waiting = runAs({ kind: "enrich" }, () => onGpu(enrich.run));
    await tick();
    expect(log).toEqual([]);

    finished();
    await tick();
    expect(log).toEqual(["enrich"]);
    enrich.release();
    await waiting;
  });

  it("tells waiting questions their place, and 0 when their turn comes", async () => {
    const log: string[] = [];
    const busy = job(log, "busy");
    const running = onGpu(busy.run);
    await tick();

    const places: Record<string, number[]> = { first: [], second: [] };
    const first = job(log, "first");
    const second = job(log, "second");
    const waits = [
      runAs({ kind: "answer", onPosition: (p) => places.first!.push(p) }, () => onGpu(first.run)),
      runAs({ kind: "answer", onPosition: (p) => places.second!.push(p) }, () => onGpu(second.run)),
    ];
    await tick();
    expect(places).toEqual({ first: [1], second: [2] });

    busy.release();
    await running;
    await tick();
    expect(places).toEqual({ first: [1, 0], second: [2, 1] });

    first.release();
    await tick();
    second.release();
    await Promise.all(waits);
    expect(places.second).toEqual([2, 1, 0]);
  });

  it("does not announce a place when the GPU is free", async () => {
    const places: number[] = [];
    await runAs({ kind: "answer", onPosition: (p) => places.push(p) }, () => onGpu(async () => "ok"));

    expect(places).toEqual([]);
  });

  it("adds the time spent waiting to the context", async () => {
    const log: string[] = [];
    const busy = job(log, "busy");
    const running = onGpu(busy.run);
    const context: JobContext = { kind: "answer" };
    const waiting = runAs(context, () => onGpu(async () => "ok"));

    await new Promise((resolve) => setTimeout(resolve, 30));
    busy.release();
    await running;
    await waiting;

    expect(context.waitedMs).toBeGreaterThanOrEqual(25);
  });

  it("a cancelled question leaves the queue and the others move up", async () => {
    const log: string[] = [];
    const busy = job(log, "busy");
    const running = onGpu(busy.run);
    const controller = new AbortController();
    const places: number[] = [];

    const cancelled = onGpu(async () => log.push("cancelled"), controller.signal);
    const next = runAs({ kind: "answer", onPosition: (p) => places.push(p) }, () => onGpu(async () => log.push("next")));
    await tick();
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    busy.release();
    await running;
    await next;
    expect(log).toEqual(["busy", "next"]);
  });

  it("rejects at once when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(onGpu(async () => "ok", controller.signal)).rejects.toThrow();
  });

  it("frees the GPU when a job fails", async () => {
    await expect(onGpu(async () => Promise.reject(new Error("ollama down")))).rejects.toThrow("ollama down");

    await expect(onGpu(async () => "ok")).resolves.toBe("ok");
  });

  it("counts questions being answered, and is idle when none are left", async () => {
    const first = startQuestion();
    const second = startQuestion();
    expect(activeQuestionCount()).toBe(2);
    let idle = false;
    const waiting = questionsIdle().then(() => (idle = true));

    first();
    first(); // twice counts once
    await tick();
    expect(idle).toBe(false);

    second();
    await waiting;
    expect(activeQuestionCount()).toBe(0);
  });
});
