/**
 * Builds src/rag/wordFrequencies.json: how often each Persian word occurs in
 * good text layers. OCR uses it to repair words the vision model wrote with
 * their letters reversed («هب» -> «به»): a word is flipped only when the
 * flipped spelling is much more common.
 *
 *   npm run build:words
 *
 * Source: the text-layer chunks of the eval documents (eval/questions.json,
 * newest version of each file), i.e. course notes, not students' uploads.
 * Pages with broken text are skipped, and rare words (fewer than MIN_COUNT)
 * are left out, so names and typos don't end up in the repository.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";
import { PERSIAN_WORD, assessPage, normalizeText } from "../src/rag/textQuality.js";

const MIN_COUNT = 3;
const OUTPUT = "src/rag/wordFrequencies.json";

const questions = JSON.parse(await readFile("eval/questions.json", "utf-8")) as { filename: string }[];
const filenames = [...new Set(questions.map((q) => q.filename))];

const { rows } = await pool.query<{ content: string }>(
  `SELECT dc.content
   FROM document_chunks dc
   WHERE dc.extraction_method = 'text'
     AND dc.document_id IN (
       SELECT DISTINCT ON (filename) id FROM documents
       WHERE filename = ANY($1) AND status = 'completed'
       ORDER BY filename, id DESC
     )`,
  [filenames],
);

const counts = new Map<string, number>();
let used = 0;

for (const { content } of rows) {
  if (!assessPage(content, 20).ok) continue;
  used++;
  for (const word of normalizeText(content).match(PERSIAN_WORD) ?? []) {
    if ([...word].length < 2) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
}

const kept = Object.fromEntries(
  [...counts.entries()].filter(([, count]) => count >= MIN_COUNT).sort((a, b) => b[1] - a[1]),
);

await writeFile(OUTPUT, `${JSON.stringify(kept, null, 0)}\n`);
console.log(`${Object.keys(kept).length} words from ${used} chunks of ${filenames.length} documents -> ${OUTPUT}`);

await pool.end();
