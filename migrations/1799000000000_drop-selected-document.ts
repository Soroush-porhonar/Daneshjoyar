import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * Questions are answered from all of a user's documents, so there is no
 * selected document anymore.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.dropColumn("conversations", "selected_document_id");
}

export function down(pgm: MigrationBuilder): void {
  pgm.addColumn("conversations", {
    selected_document_id: {
      type: "integer",
      references: "documents",
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
  });
  pgm.createIndex("conversations", "selected_document_id");
}
