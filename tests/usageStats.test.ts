import { describe, expect, it } from "vitest";
import { byWeek, percentile, usageStats, weekStart } from "../scripts/usageStats.js";
import type { UsageRow } from "../scripts/usageStats.js";
import { NO_RELEVANT_CONTENT_TEXT, SOURCES_HEADING } from "../src/messages.js";

const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  route: "document",
  rewritten_question: null,
  answer: `پشته LIFO است [1].\n\n${SOURCES_HEADING}\n- [1] notes.pdf — صفحه 3`,
  latency_ms: 10_000,
  feedback: null,
  created_at: new Date(2026, 10, 9, 20, 0),
  ...overrides,
});

describe("usageStats (npm run feedback)", () => {
  it("counts routes, rewrites, refusals and votes", () => {
    const stats = usageStats([
      row({ feedback: 1 }),
      row({ rewritten_question: "پشته چیست؟", latency_ms: 20_000 }),
      row({ answer: NO_RELEVANT_CONTENT_TEXT, latency_ms: 30_000 }),
      row({ answer: "در منابع اطلاعاتی درباره این موضوع وجود ندارد.", feedback: -1 }),
      row({ route: "chat", answer: "سلام!", latency_ms: 5_000, feedback: -1 }),
    ]);

    expect(stats).toMatchObject({
      answers: 5,
      chat: 1,
      document: 4,
      rewritten: 1,
      refused: 2,
      good: 1,
      bad: 2,
      medianMs: 10_000,
    });
  });

  it("does not count a chat answer that mentions the notes as a refusal", () => {
    expect(usageStats([row({ route: "chat", answer: NO_RELEVANT_CONTENT_TEXT })]).refused).toBe(0);
  });

  it("is all zeros without answers", () => {
    expect(usageStats([])).toMatchObject({ answers: 0, medianMs: 0, p95Ms: 0 });
  });
});

describe("percentile", () => {
  it("picks the median and the top of a small sample", () => {
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([30, 10, 20], 0.95)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 100], 0.95)).toBe(20);
  });
});

describe("weekStart / byWeek (weeks start on Saturday)", () => {
  it("maps every day of a week to its Saturday", () => {
    // 2026-11-07 is a Saturday.
    expect(weekStart(new Date(2026, 10, 7, 0, 5))).toBe("2026-11-07");
    expect(weekStart(new Date(2026, 10, 9, 20, 0))).toBe("2026-11-07");
    expect(weekStart(new Date(2026, 10, 13, 23, 59))).toBe("2026-11-07");
    expect(weekStart(new Date(2026, 10, 14, 0, 0))).toBe("2026-11-14");
  });

  it("crosses a month boundary", () => {
    expect(weekStart(new Date(2026, 10, 2, 9, 0))).toBe("2026-10-31");
  });

  it("groups rows by week, oldest first", () => {
    const weeks = byWeek([
      row({ created_at: new Date(2026, 10, 10) }),
      row({ created_at: new Date(2026, 9, 30) }),
      row({ created_at: new Date(2026, 10, 9) }),
    ]);

    expect(weeks.map(([week, rows]) => [week, rows.length])).toEqual([
      ["2026-10-24", 1],
      ["2026-11-07", 2],
    ]);
  });
});
