import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN run_in_background INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE scheduled_task_run_threads (
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    thread_id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX scheduled_task_run_threads_task_idx
    ON scheduled_task_run_threads(task_id, created_at DESC, thread_id DESC)`;
});
