/** The live numbers of `npm run feedback`, computed from answer_logs rows. */
import { SOURCES_HEADING } from "../src/messages.js";
import { isRefusal } from "../src/rag/answer.js";

export interface UsageRow {
  route: string;
  rewritten_question: string | null;
  answer: string;
  latency_ms: number;
  /** 1 = 👍, -1 = 👎, null = not rated. */
  feedback: number | null;
  created_at: Date;
}

export interface UsageStats {
  answers: number;
  chat: number;
  document: number;
  /** Document answers whose question the rewrite step changed. */
  rewritten: number;
  /** Document answers saying the notes don't cover the question. */
  refused: number;
  good: number;
  bad: number;
  medianMs: number;
  p95Ms: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  return [...values].sort((a, b) => a - b)[Math.floor(p * (values.length - 1))]!;
}

export function usageStats(rows: UsageRow[]): UsageStats {
  const documents = rows.filter((row) => row.route === "document");
  const latencies = rows.map((row) => row.latency_ms);

  return {
    answers: rows.length,
    chat: rows.filter((row) => row.route === "chat").length,
    document: documents.length,
    rewritten: documents.filter((row) => row.rewritten_question !== null).length,
    refused: documents.filter((row) => isRefusal(row.answer.split(SOURCES_HEADING)[0]!.trim())).length,
    good: rows.filter((row) => row.feedback === 1).length,
    bad: rows.filter((row) => row.feedback === -1).length,
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
}

/** The Saturday that starts a date's week (the Iranian week), as YYYY-MM-DD in local time. */
export function weekStart(date: Date): string {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): Sunday = 0 ... Saturday = 6.
  start.setDate(start.getDate() - ((start.getDay() + 1) % 7));

  const pad = (value: number) => String(value).padStart(2, "0");
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

/** Rows grouped by the week they were answered in, oldest week first. */
export function byWeek<T extends { created_at: Date }>(rows: T[]): [string, T[]][] {
  const weeks = new Map<string, T[]>();

  for (const row of rows) {
    const week = weekStart(row.created_at);
    weeks.set(week, [...(weeks.get(week) ?? []), row]);
  }

  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b));
}
