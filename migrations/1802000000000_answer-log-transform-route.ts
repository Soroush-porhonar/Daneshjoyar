import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/** Answers that reshape the previous answer ("shorter", "in three sentences") are logged with their own route. */
export function up(pgm: MigrationBuilder): void {
  pgm.dropConstraint("answer_logs", "answer_logs_route_check");
  pgm.addConstraint("answer_logs", "answer_logs_route_check", {
    check: "route IN ('document', 'document_info', 'transform', 'chat')",
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql("UPDATE answer_logs SET route = 'document' WHERE route = 'transform'");
  pgm.dropConstraint("answer_logs", "answer_logs_route_check");
  pgm.addConstraint("answer_logs", "answer_logs_route_check", {
    check: "route IN ('document', 'document_info', 'chat')",
  });
}
