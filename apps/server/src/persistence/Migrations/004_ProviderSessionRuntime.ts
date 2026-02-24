import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_session_runtime (
      provider_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_thread
    ON provider_session_runtime(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_status
    ON provider_session_runtime(status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider
    ON provider_session_runtime(provider_name)
  `;
});
