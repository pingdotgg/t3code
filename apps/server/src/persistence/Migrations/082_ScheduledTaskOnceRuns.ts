import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_task_once_runs (
    task_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    started_at TEXT NOT NULL
  )`;
});
