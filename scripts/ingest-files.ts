/**
 * Ingests local PDFs or photos (.jpg, .png, .webp) for a Bale chat id without going through the bot.
 *   npm run ingest -- <chatId> <file.pdf> [more.pdf page.jpg ...]
 * A leading "<timestamp>-" in the file name (as saved in uploads/) is removed.
 */
import { basename } from "node:path";
import { findOrCreateUser } from "../src/db/users.js";
import { pool } from "../src/db/pool.js";
import { documentKind, ingestDocument } from "../src/rag/ingest.js";

const [chatId, ...files] = process.argv.slice(2);

if (!chatId || files.length === 0) {
  console.error("Usage: npm run ingest -- <chatId> <file.pdf> [...]");
  process.exit(1);
}

const user = await findOrCreateUser(chatId);

for (const file of files) {
  const filename = basename(file).replace(/^\d{10,}-/, "");
  const started = Date.now();
  const kind = documentKind(filename);

  if (!kind) {
    console.error(`SKIP ${filename}: not a PDF or image`);
    continue;
  }

  try {
    const result = await ingestDocument(user.id, filename, file, undefined, null, kind);
    console.log(
      `OK   #${result.documentId} ${filename} (${Math.round((Date.now() - started) / 1000)}s, ` +
        `${result.pageCount} pages, ${result.ocrPages} OCR)`,
    );
  } catch (error) {
    console.error(`FAIL ${filename}:`, error instanceof Error ? error.message : error);
  }
}

await pool.end();
