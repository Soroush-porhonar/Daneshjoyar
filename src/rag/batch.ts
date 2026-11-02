/**
 * Groups chunks, in order, into batches whose total text stays within
 * `maxChars`, so a batch always fits in the model's context window.
 * A single oversized chunk still gets a batch of its own.
 */
export function batchByChars<T extends { content: string }>(
  chunks: T[],
  maxChars: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;

  for (const chunk of chunks) {
    if (current.length > 0 && size + chunk.content.length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }

    current.push(chunk);
    size += chunk.content.length;
  }

  if (current.length > 0) batches.push(current);

  return batches;
}

/** Cuts each summary to its share of `maxChars`, so all sections are represented. */
export function fitSummaries(summaries: string[], maxChars: number): string[] {
  const share = Math.floor(maxChars / Math.max(summaries.length, 1));
  return summaries.map((summary) => (summary.length > share ? `${summary.slice(0, share)}…` : summary));
}
