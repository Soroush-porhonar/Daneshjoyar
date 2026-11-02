import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * Answers now draw on several documents, so the log records all of them.
 * document_id stays for rows logged before (one selected document per answer).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumn("answer_logs", {
    document_ids: { type: "integer[]", notNull: true, default: pgm.func("'{}'::integer[]") },
  });
  pgm.sql(
    "UPDATE answer_logs SET document_ids = ARRAY[document_id] WHERE document_id IS NOT NULL",
  );
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumn("answer_logs", "document_ids");
}
