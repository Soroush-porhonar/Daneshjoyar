/**
 * Fills documents.file_path for uploads from before it was recorded
 * (migration 1806), so deleting those documents removes their files too.
 *
 * Files are saved as uploads/<download time in ms>-<file name>; the row is
 * created just after the download. A file is matched to the document with
 * the same file name whose created_at is closest after the file's time,
 * within 10 minutes (OCR runs after the row exists, so that is plenty).
 * Files that match nothing are listed, not deleted.
 *
 *   npm run backfill:files            # shows what it would do
 *   npm run backfill:files -- --apply # writes the paths
 */
import { readdir } from "node:fs/promises";
import { pool } from "../src/db/pool.js";

const apply = process.argv.includes("--apply");
const MAX_GAP_MS = 10 * 60_000;

const files = (await readdir("uploads").catch(() => [] as string[]))
  .map((name) => ({ name, match: /^(\d{13})-(.+)$/.exec(name) }))
  .filter((file): file is { name: string; match: RegExpExecArray } => file.match !== null)
  .map(({ name, match }) => ({ name, savedAt: Number(match[1]), filename: match[2]! }));

const { rows: documents } = await pool.query<{ id: number; filename: string; created_at: Date }>(
  `SELECT id, filename, created_at FROM documents WHERE file_path IS NULL`,
);

const taken = new Set<number>();
const unmatched: string[] = [];
let filled = 0;

for (const file of files.sort((a, b) => a.savedAt - b.savedAt)) {
  const candidates = documents
    .filter((document) => !taken.has(document.id) && document.filename === file.filename)
    .map((document) => ({ document, gap: document.created_at.getTime() - file.savedAt }))
    .filter(({ gap }) => gap >= -5_000 && gap <= MAX_GAP_MS)
    .sort((a, b) => a.gap - b.gap);
  const best = candidates[0];

  if (!best) {
    unmatched.push(file.name);
    continue;
  }

  taken.add(best.document.id);
  filled++;
  const filePath = `uploads/${file.name}`;
  console.log(`document ${best.document.id} <- ${filePath} (${Math.round(best.gap / 1000)} s apart)`);
  if (apply) await pool.query(`UPDATE documents SET file_path = $2 WHERE id = $1`, [best.document.id, filePath]);
}

console.log(`\n${filled} of ${files.length} files matched to a document${apply ? "; written" : " (dry run: --apply to write)"}`);
if (unmatched.length > 0) console.log(`No document (left on disk): ${unmatched.join(", ")}`);
console.log(`Documents still without a file: ${documents.length - filled}`);
await pool.end();
