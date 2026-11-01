import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_webhook_delivery_id TEXT`;
  yield* sql`CREATE TABLE scheduled_task_webhook_replay_keys (
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    replay_key TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, replay_key)
  )`;
  yield* sql`CREATE INDEX idx_webhook_replay_expiry ON scheduled_task_webhook_replay_keys(expires_at)`;
  yield* sql`CREATE INDEX idx_webhook_replay_delivery ON scheduled_task_webhook_replay_keys(delivery_id)`;
  yield* sql`CREATE TABLE scheduled_task_webhook_pending (
    delivery_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    coalesce_key TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    task_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    delivery_ids_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_webhook_pending_due ON scheduled_task_webhook_pending(state, due_at)`;
  yield* sql`CREATE UNIQUE INDEX idx_webhook_pending_key
    ON scheduled_task_webhook_pending(task_id, coalesce_key) WHERE state = 'pending'`;
});
