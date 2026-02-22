import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_aggregate
    ON orchestration_events(aggregate_type, aggregate_id, sequence)
  `;
});
