import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Kept out of schedule_json so they never decode into the read model.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN webhook_token TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN webhook_secret TEXT`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      method TEXT NOT NULL,
      query TEXT NOT NULL,
      headers_json TEXT NOT NULL,
      body TEXT NOT NULL,
      body_bytes INTEGER NOT NULL,
      body_truncated INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      signature_verified INTEGER NOT NULL,
      missing_fields_json TEXT NOT NULL,
      rendered_prompt TEXT,
      error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_webhook_deliveries_task
    ON scheduled_task_webhook_deliveries(task_id, received_at)
  `;
});
