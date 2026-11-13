import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/** Answers to questions about a document itself are logged with their own route. */
export function up(pgm: MigrationBuilder): void {
  pgm.dropConstraint("answer_logs", "answer_logs_route_check");
  pgm.addConstraint("answer_logs", "answer_logs_route_check", {
    check: "route IN ('document', 'document_info', 'chat')",
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql("UPDATE answer_logs SET route = 'document' WHERE route = 'document_info'");
  pgm.dropConstraint("answer_logs", "answer_logs_route_check");
  pgm.addConstraint("answer_logs", "answer_logs_route_check", {
    check: "route IN ('document', 'chat')",
  });
}
