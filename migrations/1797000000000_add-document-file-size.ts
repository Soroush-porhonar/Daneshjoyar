import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * File size of each uploaded PDF, so a user can't upload the same file twice
 * (same name and size). The unique index also stops two quick uploads of the
 * same file; failed uploads don't count, so a file can be sent again after a
 * failure. Documents from before this migration have no size and never match.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumn("documents", { file_size: { type: "bigint" } });
  pgm.createIndex("documents", ["user_id", "filename", "file_size"], {
    name: "documents_no_duplicate_upload",
    unique: true,
    where: "status <> 'failed' AND file_size IS NOT NULL",
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex("documents", ["user_id", "filename", "file_size"], {
    name: "documents_no_duplicate_upload",
  });
  pgm.dropColumn("documents", "file_size");
}
