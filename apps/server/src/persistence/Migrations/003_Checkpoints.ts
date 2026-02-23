import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_checkpoints (
      provider_session_id TEXT,
      thread_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      label TEXT NOT NULL,
      preview TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_count)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_checkpoints_thread_turn
    ON provider_checkpoints(thread_id, turn_count ASC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_checkpoints_session
    ON provider_checkpoints(provider_session_id)
  `;
});
