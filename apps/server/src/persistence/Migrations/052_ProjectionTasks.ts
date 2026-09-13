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
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_created_at_task_id
    ON projection_tasks(created_at, task_id)
  `;
  // Pre-task histories have nothing to rebuild. Imported task histories still need replay.
  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT 'projection.tasks', COALESCE(MAX(sequence), 0),
           COALESCE(MAX(occurred_at), '1970-01-01T00:00:00.000Z')
    FROM orchestration_events
    HAVING NOT EXISTS (
      SELECT 1 FROM orchestration_events WHERE aggregate_kind = 'task'
    )
    ON CONFLICT(projector) DO NOTHING
  `;
});
