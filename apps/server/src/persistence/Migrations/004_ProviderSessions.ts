import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_sessions (
      session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_sessions_provider
    ON provider_sessions(provider)
  `;
});
