/**
 * Bootstrap confidence intervals for eval metrics. With ~90 questions one
 * question moves a share by about a point (and a group of 10 by ten), so a
 * change is only real when its interval stays clear of zero.
 *
 * Resamples the questions with replacement many times; the middle 95% of the
 * resampled means is the interval. Seeded, so reruns print the same numbers.
 */

/** Small deterministic PRNG (mulberry32): same seed, same sequence. */
function random(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** 95% interval of the mean of `values` (e.g. 1 = hit, 0 = miss per question). */
export function bootstrapInterval(
  values: number[],
  samples = 2000,
  seed = 1,
): [low: number, high: number] {
  if (values.length === 0) return [0, 0];

  const next = random(seed);
  const means = Array.from({ length: samples }, () =>
    mean(values.map(() => values[Math.floor(next() * values.length)]!)),
  ).sort((a, b) => a - b);

  return [means[Math.floor(samples * 0.025)]!, means[Math.ceil(samples * 0.975) - 1]!];
}

/**
 * 95% interval of the change between two runs on the same questions
 * (paired: `after[i]` and `before[i]` are the same question).
 */
export function pairedInterval(
  before: number[],
  after: number[],
  samples = 2000,
  seed = 1,
): [low: number, high: number] {
  if (before.length !== after.length) throw new Error("Paired runs must have the same questions");

  return bootstrapInterval(
    after.map((value, i) => value - before[i]!),
    samples,
    seed,
  );
}
