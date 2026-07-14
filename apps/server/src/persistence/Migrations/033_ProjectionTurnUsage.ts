import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_usage (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_instance_id TEXT,
      model TEXT,
      usage_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_thread_updated
    ON projection_turn_usage(thread_id, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_provider_updated
    ON projection_turn_usage(provider, updated_at)
  `;
});
