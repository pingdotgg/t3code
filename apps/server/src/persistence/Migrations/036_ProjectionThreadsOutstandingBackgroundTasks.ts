import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "outstanding_background_task_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN outstanding_background_task_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!columns.some((column) => column.name === "outstanding_background_task_started_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN outstanding_background_task_started_at TEXT
    `;
  }

  // Backfill from the projected activity timeline, mirroring the live
  // derivation in ProjectionPipeline: a task counts only with a well-formed
  // string taskId, and it is settled only by a task.completed at or after the
  // task's first opening activity — a stale completed that precedes the start
  // does not settle it, and a progress row after a completed does not reopen
  // it. The outer WHERE is the session gate: a thread whose provider process
  // is gone takes its children with it, so dead threads keep the 0/NULL
  // default instead of resurrecting as permanently working.
  yield* sql`
    UPDATE projection_threads
    SET
      outstanding_background_task_count = COALESCE((
        SELECT COUNT(DISTINCT json_extract(open_activity.payload_json, '$.taskId'))
        FROM projection_thread_activities AS open_activity
        WHERE open_activity.thread_id = projection_threads.thread_id
          AND open_activity.kind IN ('task.started', 'task.progress')
          AND json_type(open_activity.payload_json, '$.taskId') = 'text'
          AND TRIM(json_extract(open_activity.payload_json, '$.taskId')) <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS settled_activity
            WHERE settled_activity.thread_id = open_activity.thread_id
              AND settled_activity.kind = 'task.completed'
              AND json_extract(settled_activity.payload_json, '$.taskId')
                = json_extract(open_activity.payload_json, '$.taskId')
              AND settled_activity.created_at >= (
                SELECT MIN(first_open.created_at)
                FROM projection_thread_activities AS first_open
                WHERE first_open.thread_id = open_activity.thread_id
                  AND first_open.kind IN ('task.started', 'task.progress')
                  AND json_extract(first_open.payload_json, '$.taskId')
                    = json_extract(open_activity.payload_json, '$.taskId')
              )
          )
      ), 0),
      outstanding_background_task_started_at = (
        SELECT MIN(open_activity.created_at)
        FROM projection_thread_activities AS open_activity
        WHERE open_activity.thread_id = projection_threads.thread_id
          AND open_activity.kind IN ('task.started', 'task.progress')
          AND json_type(open_activity.payload_json, '$.taskId') = 'text'
          AND TRIM(json_extract(open_activity.payload_json, '$.taskId')) <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS settled_activity
            WHERE settled_activity.thread_id = open_activity.thread_id
              AND settled_activity.kind = 'task.completed'
              AND json_extract(settled_activity.payload_json, '$.taskId')
                = json_extract(open_activity.payload_json, '$.taskId')
              AND settled_activity.created_at >= (
                SELECT MIN(first_open.created_at)
                FROM projection_thread_activities AS first_open
                WHERE first_open.thread_id = open_activity.thread_id
                  AND first_open.kind IN ('task.started', 'task.progress')
                  AND json_extract(first_open.payload_json, '$.taskId')
                    = json_extract(open_activity.payload_json, '$.taskId')
              )
          )
      )
    WHERE EXISTS (
      SELECT 1
      FROM projection_thread_sessions AS session
      WHERE session.thread_id = projection_threads.thread_id
        AND session.status IN ('starting', 'running', 'ready')
    )
  `;
});
