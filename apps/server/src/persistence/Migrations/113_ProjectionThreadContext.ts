import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionQueuedTurns from "./033_ProjectionQueuedTurns.ts";

/**
 * Thread-context columns for projected messages and queued turns.
 *
 * Follows migration 056: ledgers from a divergent branch can record IDs above
 * 33 without ever creating `projection_queued_turns`, so ensure the table
 * exists (idempotent CREATE IF NOT EXISTS from 033) before adding the column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "context_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN context_json TEXT
    `;
  }

  // Repair installs that skipped migration 033 because a divergent ledger's
  // high-water mark jumped past it.
  yield* ProjectionQueuedTurns;

  const queuedTurnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_queued_turns)
  `;
  if (!queuedTurnColumns.some((column) => column.name === "context_json")) {
    yield* sql`
      ALTER TABLE projection_queued_turns
      ADD COLUMN context_json TEXT
    `;
  }
});
