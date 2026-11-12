/** Shared by the eval scripts. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { SOURCES_HEADING } from "../src/messages.js";
import { rankedCandidates, relevantHits } from "../src/rag/retrieve.js";
import type { ChunkRef } from "../src/rag/retrieve.js";
import type { HistoryMessage } from "../src/rag/rewrite.js";

export const RESULTS_DIR = "eval/results";

/** Saves a run as eval/results/<kind>-<timestamp>.json (git-ignored) and returns the path. */
export async function saveResult(kind: string, data: Record<string, unknown>): Promise<string> {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${RESULTS_DIR}/${kind}-${stamp}.json`;

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path, JSON.stringify({ date: now.toISOString(), ...data }, null, 2));
  return path;
}

/** The newest saved run of a kind, or null. Read it before saving the current run. */
export async function previousResult<T>(kind: string): Promise<{ file: string; data: T } | null> {
  try {
    const file = (await readdir(RESULTS_DIR)).filter((name) => name.startsWith(`${kind}-`)).sort().at(-1);
    if (!file) return null;
    return { file, data: JSON.parse(await readFile(`${RESULTS_DIR}/${file}`, "utf-8")) as T };
  } catch {
    return null;
  }
}

export type RouterMode = "focused" | "multi_part" | "broad";

/** One labelled message of eval/router.json. */
export interface RouterCase {
  id: string;
  message: string;
  history?: HistoryMessage[];
  route: "document" | "chat";
  /**
   * Document cases: the right retrieval mode, or several acceptable ones.
   * Left out when only the route matters (questions about the handout itself).
   */
  mode?: RouterMode | RouterMode[];
  /** What kind of message it is; accuracy is reported per kind. */
  kind?: string;
  /** Whether the message only makes sense with the conversation (so it needs rewriting). */
  dependsOnHistory?: boolean;
}

const routeLabel = (route: string, mode?: string) => (route === "chat" ? "chat" : `doc:${mode}`);

/**
 * Compares the router's decision with a case's label. With several accepted
 * modes (or none), the expected label shown is the router's own mode when it
 * is acceptable, otherwise the first accepted one.
 */
export function scoreRoute(
  expected: Pick<RouterCase, "route" | "mode">,
  actual: { route: "document" | "chat"; retrievalMode: RouterMode },
): { routeOk: boolean; exactOk: boolean; expectedLabel: string; actualLabel: string } {
  const accepted = expected.mode === undefined ? [] : [expected.mode].flat();
  const modeOk = accepted.length === 0 || accepted.includes(actual.retrievalMode);
  const routeOk = actual.route === expected.route;

  return {
    routeOk,
    exactOk: routeOk && (expected.route === "chat" || modeOk),
    expectedLabel: routeLabel(
      expected.route,
      actual.route === "document" && modeOk ? actual.retrievalMode : (accepted[0] ?? "focused"),
    ),
    actualLabel: routeLabel(actual.route, actual.retrievalMode),
  };
}

/**
 * What a follow-up's previous answer was based on (production reads it from
 * answer_logs): the relevant hits for the last user message in the history,
 * searched like the question itself (all the user's documents, or `documentId`).
 */
export async function previousHits(
  owner: { user_id: number },
  history: HistoryMessage[] = [],
  documentId?: number,
): Promise<ChunkRef[]> {
  const last = [...history].reverse().find((message) => message.role === "user");
  if (!last) return [];

  const ranked = relevantHits(
    await rankedCandidates(owner.user_id, last.content, documentId === undefined ? {} : { documentId }),
  );
  return ranked
    .slice(0, config.rag.retrievalLimits.focused)
    .map(({ documentId, chunkIndex }) => ({ documentId, chunkIndex }));
}

/**
 * The pages an answer's sources list cites in `filename`
 * ("- [2] notes.pdf — صفحه 3", or a range "صفحه 3 تا 5" for a chunk crossing pages).
 */
export function citedPages(answer: string, filename: string): number[] {
  const sources = answer.split(SOURCES_HEADING)[1] ?? "";

  return sources.split("\n").flatMap((line) => {
    const match = /^- (?:\[\d+\] )?(.+) — صفحه (\d+)(?: تا (\d+))?$/.exec(line.trim());
    if (!match || match[1] !== filename) return [];

    const first = Number(match[2]);
    const last = Number(match[3] ?? match[2]);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
}
