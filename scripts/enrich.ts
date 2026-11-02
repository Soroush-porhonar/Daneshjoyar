/**
 * Enriches documents now, in this process (the bot does new uploads by itself):
 * section summaries, a title/summary/topics profile, and per chunk a context
 * sentence and questions it answers. Needs Ollama and the database.
 *
 *   npm run enrich -- --all              # every ready document not enriched yet
 *   npm run enrich -- --user 288         # one user's documents
 *   npm run enrich -- --doc 58 --doc 59  # specific documents
 *   npm run enrich -- --all --force      # also redo enriched ones
 */
import { documentsToEnrich, setEnrichmentStatus } from "../src/db/enrichment.js";
import { pool } from "../src/db/pool.js";
import { enrichDocument } from "../src/rag/enrich.js";

const args = process.argv.slice(2);
const values = (name: string) =>
  args.flatMap((arg, i) => (args[i - 1] === `--${name}` ? [Number(arg)] : []));

const userId = values("user")[0];
const documentIds = values("doc");

if (!args.includes("--all") && userId === undefined && documentIds.length === 0) {
  console.error("Usage: npm run enrich -- --all | --user <id> | --doc <id> [--doc <id>] [--force]");
  process.exit(1);
}

const ids = await documentsToEnrich({
  ...(userId === undefined ? {} : { userId }),
  ...(documentIds.length === 0 ? {} : { documentIds }),
  force: args.includes("--force"),
});
console.log(`Enriching ${ids.length} document(s): ${ids.join(", ")}`);

for (const [index, id] of ids.entries()) {
  console.log(`\n[${index + 1}/${ids.length}] document ${id}`);
  await setEnrichmentStatus(id, "running");

  try {
    await enrichDocument(id);
  } catch (error: unknown) {
    console.error(`Document ${id} failed:`, error);
    await setEnrichmentStatus(id, "failed");
  }
}

await pool.end();
