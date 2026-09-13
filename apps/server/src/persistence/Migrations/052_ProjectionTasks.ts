import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      primary_project_id TEXT NOT NULL,
      archived_at TEXT,
      settled_override TEXT,
      settled_at TEXT,
      unsettled_at TEXT,
      snoozed_until TEXT,
      snoozed_at TEXT,
      pinned_at TEXT,
      pin_order_key TEXT,
      active_order_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_primary_project_id
    ON projection_tasks(primary_project_id)
  `;
});
