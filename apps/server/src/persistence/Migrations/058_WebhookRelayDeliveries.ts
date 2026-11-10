import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Retain handled ids longer than relay requests; the 50-row delivery log cannot prevent all replays.
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_webhook_relay_deliveries (
      relay_delivery_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seen_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_webhook_relay_deliveries_seen
    ON scheduled_task_webhook_relay_deliveries(seen_at)
  `;
});
