import { describe, expect, it } from "vitest";
import { bootstrapInterval, pairedInterval } from "../scripts/bootstrap.js";

const hits = (hit: number, total: number) =>
  Array.from({ length: total }, (_, i) => (i < hit ? 1 : 0));

describe("bootstrapInterval", () => {
  it("contains the observed share and is wide for few questions", () => {
    const [low, high] = bootstrapInterval(hits(8, 10));

    expect(low).toBeLessThan(0.8);
    expect(high).toBeGreaterThan(0.8);
    expect(high - low).toBeGreaterThan(0.3);
  });

  it("narrows as questions are added", () => {
    const [smallLow, smallHigh] = bootstrapInterval(hits(8, 10));
    const [bigLow, bigHigh] = bootstrapInterval(hits(80, 100));

    expect(bigHigh - bigLow).toBeLessThan(smallHigh - smallLow);
  });

  it("is the same on every run (seeded)", () => {
    expect(bootstrapInterval(hits(7, 20))).toEqual(bootstrapInterval(hits(7, 20)));
  });

  it("is a point when every question agrees", () => {
    expect(bootstrapInterval(hits(5, 5))).toEqual([1, 1]);
  });
});

describe("pairedInterval", () => {
  it("excludes zero for a clear improvement", () => {
    const [low] = pairedInterval(hits(50, 100), hits(80, 100));

    expect(low).toBeGreaterThan(0);
  });

  it("includes zero when two questions swap", () => {
    const before = [1, 0, ...hits(40, 50)];
    const after = [0, 1, ...hits(40, 50)];
    const [low, high] = pairedInterval(before, after);

    expect(low).toBeLessThan(0);
    expect(high).toBeGreaterThan(0);
  });
});
