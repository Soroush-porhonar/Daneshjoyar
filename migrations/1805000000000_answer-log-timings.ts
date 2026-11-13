import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * Per-answer stage timings from real use (roadmap Q2, 8.11): queue wait,
 * time to first text, generation, token counts. `npm run feedback` reports
 * their percentiles. Kept when the answer text is removed by retention.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumn("answer_logs", { timings: { type: "jsonb" } });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumn("answer_logs", "timings");
}
