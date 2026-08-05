import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionQueuedTurns from "./033_ProjectionQueuedTurns.ts";

/**
 * Workspace-handoff origin columns for projected messages and queued turns.
 *
 * Ledgers from a divergent branch can record IDs above 33 without ever creating
 * `projection_queued_turns`, so ALTER alone fails with "no such table". Ensure the
 * table exists (idempotent CREATE IF NOT EXISTS from 033) before adding the column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "origin_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN origin_json TEXT
    `;
  }

  // Repair installs that skipped migration 033 because a divergent ledger's
  // high-water mark jumped past it.
  yield* ProjectionQueuedTurns;

  const queuedTurnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_queued_turns)
  `;
  if (!queuedTurnColumns.some((column) => column.name === "origin_json")) {
    yield* sql`
      ALTER TABLE projection_queued_turns
      ADD COLUMN origin_json TEXT
    `;
  }
});
