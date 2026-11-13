import { normalizeText } from "./textQuality.js";

/** Parts shorter than this are a coordinated word ("مزایا و معایب"), not a concept of their own. */
const MIN_PART_WORDS = 3;
const MAX_PARTS = 4;

/**
 * The concepts of a multi-part question, split at «و» and «،»:
 * "الگوریتم کروسکال و الگوریتم دایجکسترا هر کدام چه کاری می‌کنند؟" gives both
 * halves. One search for the whole question tends to find the page of one
 * concept only (roadmap P3, screenshot 3). Returns [] when there are fewer
 * than two parts worth searching on their own.
 */
export function extractConcepts(question: string): string[] {
  const parts = normalizeText(question)
    .replace(/[؟?!.]+$/g, "")
    .split(/\s+و\s+|،|,/)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= MIN_PART_WORDS);

  return parts.length >= 2 ? parts.slice(0, MAX_PARTS) : [];
}
