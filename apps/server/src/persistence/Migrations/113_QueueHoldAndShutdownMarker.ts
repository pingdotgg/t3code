import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Three durability additions for the queued-message queue:
 *
 * 1. `projection_queued_turns.queue_position` — explicit per-thread delivery
 *    order, so a user reorder survives a restart instead of being rebuilt from
 *    creation timestamps. Existing rows are backfilled from their current
 *    `created_at` order, which is exactly the order they already delivered in.
 * 2. `projection_threads.queue_held_at` — a thread-level hold. When non-null
 *    the queue will not drain until the user releases it, so a queued prompt
 *    never fires unprompted after crash recovery.
 * 3. `server_shutdown_marker` — a single row recording whether the previous
 *    server process shut down cleanly. Boot reads and clears it; the graceful
 *    shutdown finalizer sets it. An unset row means the last process died,
 *    which is what distinguishes crash recovery from a planned restart.
 *
 * All statements are idempotent because a divergent migration ledger can skip
 * an earlier migration and replay this one against a database that already has
 * some of the shape (see scars: preserve released migration ordering).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "queue_held_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN queue_held_at TEXT
    `;
  }

  const queuedTurnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_queued_turns)
  `;

  if (!queuedTurnColumns.some((column) => column.name === "queue_position")) {
    yield* sql`
      ALTER TABLE projection_queued_turns
      ADD COLUMN queue_position INTEGER
    `;

    // Preserve the order these turns are already queued in. ROW_NUMBER is
    // zero-based so the first message keeps position 0, matching the
    // `max(position) + 1` the create path assigns to the next turn.
    yield* sql`
      UPDATE projection_queued_turns
      SET queue_position = (
        SELECT COUNT(*) - 1
        FROM projection_queued_turns AS earlier
        WHERE earlier.thread_id = projection_queued_turns.thread_id
          AND (
            earlier.created_at < projection_queued_turns.created_at
            OR (
              earlier.created_at = projection_queued_turns.created_at
              AND earlier.queued_turn_id <= projection_queued_turns.queued_turn_id
            )
          )
      )
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS server_shutdown_marker (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      clean_shutdown_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO server_shutdown_marker (id, clean_shutdown_at)
    VALUES (1, '')
    ON CONFLICT (id) DO NOTHING
  `;
});
