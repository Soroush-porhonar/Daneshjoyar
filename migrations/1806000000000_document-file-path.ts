import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * Where the uploaded file is kept (relative to the bot's working directory,
 * e.g. uploads/1731500000000-notes.pdf), so deleting the document removes it
 * (roadmap 8.10). Older rows are filled by scripts/backfill-file-paths.ts.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumn("documents", { file_path: { type: "text" } });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumn("documents", "file_path");
}
