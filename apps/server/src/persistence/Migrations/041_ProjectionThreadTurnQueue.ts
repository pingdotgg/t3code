import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_turn_queue (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      model_selection_json TEXT,
      title_seed TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      queued_at TEXT NOT NULL,
      event_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'handoff'))
    )
  `;

  yield* sql`
    CREATE INDEX idx_projection_thread_turn_queue_thread_sequence
    ON projection_thread_turn_queue(thread_id, event_sequence)
  `;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN delivery_state TEXT CHECK (delivery_state IS NULL OR delivery_state = 'queued')
  `;
});
