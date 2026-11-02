import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * Upload-time enrichment (src/rag/enrich.ts), done in the background after a
 * document is usable:
 * - documents: a profile (title, summary, topics) and the enrichment status;
 *   NULL = never requested (documents from before; npm run enrich adds them)
 * - document_sections: a stored summary per group of pages (summary requests)
 * - document_chunks.context: one sentence placing the chunk in its document,
 *   and context_embedding: the chunk embedded together with that context
 * - chunk_questions: questions each chunk answers, embedded for search
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumns("documents", {
    enrichment: {
      type: "text",
      check: "enrichment IN ('pending', 'running', 'done', 'failed')",
    },
    title: { type: "text" },
    summary: { type: "text" },
    topics: { type: "text[]" },
  });
  pgm.createIndex("documents", "enrichment");

  pgm.createTable("document_sections", {
    id: "id",
    document_id: { type: "integer", notNull: true, references: "documents", onDelete: "CASCADE" },
    section_index: { type: "integer", notNull: true },
    page_start: { type: "integer" },
    page_end: { type: "integer" },
    summary: { type: "text", notNull: true },
  });
  pgm.addConstraint("document_sections", "document_sections_unique", {
    unique: ["document_id", "section_index"],
  });

  pgm.addColumns("document_chunks", {
    context: { type: "text" },
    context_embedding: { type: "vector(1024)" },
  });

  pgm.createTable("chunk_questions", {
    id: "id",
    chunk_id: { type: "integer", notNull: true, references: "document_chunks", onDelete: "CASCADE" },
    question: { type: "text", notNull: true },
    embedding: { type: "vector(1024)", notNull: true },
  });
  pgm.createIndex("chunk_questions", "chunk_id");
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("chunk_questions");
  pgm.dropColumns("document_chunks", ["context", "context_embedding"]);
  pgm.dropTable("document_sections");
  pgm.dropColumns("documents", ["enrichment", "title", "summary", "topics"]);
}
