import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/** When the student last started a new topic; earlier messages are left out of the history. */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumn("conversations", { history_start: { type: "timestamptz" } });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumn("conversations", "history_start");
}
