/**
 * Builds the distractor set: one eval-only user that holds the eval documents
 * together with many unrelated ones, so `npm run eval -- --user <id>` measures
 * how often other documents crowd out the right page (roadmap M4).
 *
 *   npm run eval:distractors -- --add-user 1          # eval documents + user 1's enriched documents
 *   npm run eval:distractors -- --add-user 1 --dry-run
 *
 * Rows are copied in SQL (documents, chunks with their embeddings, section
 * summaries, question index), so no model runs. The eval user is rebuilt from
 * scratch on every run. Documents still waiting for enrichment are skipped,
 * because without their question index they would not compete like real ones.
 * Only add users whose documents may be used for evaluation.
 */
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { pool } from "../src/db/pool.js";
import { DISTRACTOR_CHAT_ID as EVAL_CHAT_ID, evalUser } from "./evalHelpers.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const addUsers = args.flatMap((arg, i) => (args[i - 1] === "--add-user" ? [Number(arg)] : []));

const questions = JSON.parse(await readFile("eval/questions.json", "utf-8")) as { filename: string }[];
const evalFilenames = new Set(questions.map((q) => q.filename));
// The owner of the eval set; --user is not used here (it would name the eval user itself).
const owner = await evalUser([], evalFilenames);

interface SourceDocument {
  id: number;
  user_id: number;
  filename: string;
  enrichment: string | null;
}

const candidates = await pool.query<SourceDocument>(
  `SELECT id, user_id, filename, enrichment FROM documents
   WHERE status = 'completed' AND user_id = ANY($1)
   ORDER BY (user_id = $2) DESC, id DESC`,
  [[owner, ...addUsers], owner],
);

// The owner's newest copy of each eval document, then everything else once per filename.
const chosen: SourceDocument[] = [];
const skipped: string[] = [];
const names = new Set<string>();

for (const doc of candidates.rows) {
  if (names.has(doc.filename)) continue;
  if (doc.user_id === owner && !evalFilenames.has(doc.filename)) continue;
  if (doc.user_id !== owner && doc.enrichment !== "done") {
    skipped.push(`${doc.id} ${doc.filename} (enrichment ${doc.enrichment ?? "never"})`);
    continue;
  }
  names.add(doc.filename);
  chosen.push(doc);
}

const missing = [...evalFilenames].filter((name) => !names.has(name));
console.log(`Eval documents from user ${owner}: ${chosen.filter((d) => d.user_id === owner).length}`);
console.log(`Distractors: ${chosen.filter((d) => d.user_id !== owner).length}; total ${chosen.length}`);
if (missing.length > 0) console.log(`Eval files not found: ${missing.join(", ")}`);
if (skipped.length > 0) console.log(`Skipped, not enriched yet:\n  ${skipped.join("\n  ")}`);

async function copyDocument(client: PoolClient, doc: SourceDocument, userId: number): Promise<void> {
  const created = await client.query<{ id: number }>(
    `INSERT INTO documents (user_id, filename, status, file_size, enrichment, title, summary, topics)
     SELECT $2, filename, status, file_size, enrichment, title, summary, topics FROM documents WHERE id = $1
     RETURNING id`,
    [doc.id, userId],
  );
  const newId = created.rows[0]!.id;

  await client.query(
    `INSERT INTO document_chunks (document_id, chunk_index, content, embedding, page_number,
       extraction_method, page_end, section_title, section_index, context, context_embedding)
     SELECT $2, chunk_index, content, embedding, page_number,
       extraction_method, page_end, section_title, section_index, context, context_embedding
     FROM document_chunks WHERE document_id = $1`,
    [doc.id, newId],
  );
  await client.query(
    `INSERT INTO chunk_questions (chunk_id, question, embedding)
     SELECT copy.id, q.question, q.embedding
     FROM chunk_questions q
     JOIN document_chunks original ON original.id = q.chunk_id
     JOIN document_chunks copy ON copy.document_id = $2 AND copy.chunk_index = original.chunk_index
     WHERE original.document_id = $1`,
    [doc.id, newId],
  );
  await client.query(
    `INSERT INTO document_sections (document_id, section_index, page_start, page_end, summary)
     SELECT $2, section_index, page_start, page_end, summary FROM document_sections WHERE document_id = $1`,
    [doc.id, newId],
  );
}

if (dryRun) {
  for (const doc of chosen) console.log(`  ${doc.id} (user ${doc.user_id}) ${doc.filename}`);
} else {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query<{ id: number }>(
      `INSERT INTO users (bale_chat_id, first_name) VALUES ($1, 'eval')
       ON CONFLICT (bale_chat_id) DO UPDATE SET first_name = EXCLUDED.first_name
       RETURNING id`,
      [EVAL_CHAT_ID],
    );
    const userId = user.rows[0]!.id;
    await client.query("DELETE FROM documents WHERE user_id = $1", [userId]);
    for (const doc of chosen) await copyDocument(client, doc, userId);
    await client.query("COMMIT");
    console.log(`Eval user ${userId} rebuilt with ${chosen.length} documents: npm run eval -- --user ${userId}`);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();
