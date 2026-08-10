import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cursor_usage_events (
      id TEXT PRIMARY KEY,
      occurred_at_ms INTEGER NOT NULL,
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      usage_type TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_write_tokens INTEGER,
      cache_read_tokens INTEGER,
      total_tokens INTEGER,
      raw_cost_cents REAL,
      charged_cents REAL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cursor_usage_events_day
    ON cursor_usage_events(day)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cursor_usage_events_occurred_at
    ON cursor_usage_events(occurred_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cursor_usage_sync_state (
      provider TEXT PRIMARY KEY,
      last_successful_sync_at_ms INTEGER,
      sync_version INTEGER NOT NULL,
      backfill_completed INTEGER NOT NULL DEFAULT 0
    )
  `;
});
