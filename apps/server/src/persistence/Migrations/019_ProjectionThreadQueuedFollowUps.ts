import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_thread_queued_follow_ups (
      follow_up_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      queue_position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      prompt TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      terminal_contexts_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      last_send_error TEXT,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_projection_thread_queued_follow_ups_thread_position
    ON projection_thread_queued_follow_ups(thread_id, queue_position, created_at)
  `;
});
