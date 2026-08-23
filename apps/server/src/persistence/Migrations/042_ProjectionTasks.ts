import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      name TEXT,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_fired_at TEXT,
      next_fire_at TEXT,
      cancelled_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_next_fire_at
    ON projection_tasks (next_fire_at)
    WHERE next_fire_at IS NOT NULL AND cancelled_at IS NULL
  `;
});
