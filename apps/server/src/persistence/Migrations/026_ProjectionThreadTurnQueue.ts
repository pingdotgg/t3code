import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_turn_queue (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachment_ids_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      title_seed TEXT,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      queued_at TEXT NOT NULL,
      enqueue_sequence INTEGER NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_turn_queue_thread_sequence
    ON projection_thread_turn_queue(thread_id, enqueue_sequence)
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN queued_turn_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN turn_queue_status TEXT NOT NULL DEFAULT 'idle'
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN turn_queue_pause_reason TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET
      queued_turn_count = COALESCE(queued_turn_count, 0),
      turn_queue_status = COALESCE(turn_queue_status, 'idle'),
      turn_queue_pause_reason = NULLIF(turn_queue_pause_reason, '')
  `;
});
