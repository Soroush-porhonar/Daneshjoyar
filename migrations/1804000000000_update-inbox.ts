import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * processed_updates becomes an inbox (roadmap 8.9): each update is stored as
 * "received" before its work starts, so an update whose work failed or was
 * cut off by a restart is retried by the sweeper instead of lost (the poller
 * has already moved past it, and Bale does not send it again).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.addColumns("processed_updates", {
    status: {
      type: "text",
      notNull: true,
      default: "done",
      check: "status IN ('received', 'done', 'failed', 'abandoned')",
    },
    payload: { type: "jsonb" },
    attempts: { type: "integer", notNull: true, default: 1 },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  // The sweeper looks only at unfinished updates.
  pgm.createIndex("processed_updates", "status", {
    name: "processed_updates_unfinished_idx",
    where: "status IN ('received', 'failed')",
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex("processed_updates", "status", { name: "processed_updates_unfinished_idx" });
  pgm.dropColumns("processed_updates", ["status", "payload", "attempts", "updated_at"]);
}
