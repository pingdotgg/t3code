import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN work_unit_id TEXT
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_work_units (
      work_unit_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      parent_work_unit_id TEXT,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      spawned_by_activity_id TEXT,
      provider_refs_json TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_work_units_thread_turn
    ON projection_thread_work_units(thread_id, turn_id, started_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_work_units_thread_parent
    ON projection_thread_work_units(thread_id, parent_work_unit_id, started_at)
  `;

  yield* sql`
    INSERT INTO projection_thread_work_units (
      work_unit_id,
      thread_id,
      turn_id,
      parent_work_unit_id,
      kind,
      state,
      title,
      detail,
      spawned_by_activity_id,
      provider_refs_json,
      started_at,
      updated_at,
      completed_at
    )
    SELECT
      'wu:' || thread_id || ':turn:' || turn_id || ':root',
      thread_id,
      turn_id,
      NULL,
      'primary_agent',
      CASE state
        WHEN 'completed' THEN 'completed'
        WHEN 'error' THEN 'failed'
        WHEN 'interrupted' THEN 'stopped'
        ELSE 'running'
      END,
      'Primary agent',
      NULL,
      NULL,
      NULL,
      COALESCE(started_at, requested_at),
      COALESCE(completed_at, started_at, requested_at),
      CASE
        WHEN state IN ('completed', 'error', 'interrupted') THEN COALESCE(completed_at, started_at, requested_at)
        ELSE NULL
      END
    FROM projection_turns
    WHERE turn_id IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET work_unit_id = 'wu:' || thread_id || ':turn:' || turn_id || ':root'
    WHERE turn_id IS NOT NULL
      AND work_unit_id IS NULL
  `;
});
