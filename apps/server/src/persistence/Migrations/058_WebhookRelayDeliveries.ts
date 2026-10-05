import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Relay delivery ids already handled, kept longer than the relay holds a
  // request so a replay can never run twice. The delivery log keeps only the
  // newest 50 rows per task, which is too short for that.
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
