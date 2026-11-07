import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN fork_run_ids_json TEXT`;

  // thread.created survives pruning. Recover run state at that sequence when its events survive.
  // A pruned rollback has no recoverable order; exclude it rather than resurrect discarded turns.
  yield* sql`
    WITH forks AS (
      SELECT thread.thread_id,
        json_extract(thread.payload_json, '$.forkedFrom.threadId') AS source_id,
        boundary.ordinal AS boundary_ordinal,
        (SELECT MIN(event.sequence) FROM orchestration_events AS event
          WHERE event.stream_id = thread.thread_id AND event.event_type = 'thread.created'
            AND event.application_event_version = 2) AS fork_sequence
      FROM orchestration_v2_projection_threads AS thread
      LEFT JOIN orchestration_v2_projection_runs AS boundary
        ON boundary.run_id = json_extract(thread.payload_json, '$.forkedFrom.runId')
      WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
    ), memberships AS (
      SELECT fork.thread_id, (
        SELECT json_group_array(run.run_id)
        FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = fork.source_id AND run.ordinal <= fork.boundary_ordinal
          AND COALESCE((
            SELECT json_extract(event.payload_json, '$.status')
            FROM orchestration_events AS event
            WHERE event.stream_id = fork.source_id
              AND event.application_event_version = 2
              AND event.event_type IN ('run.created', 'run.updated')
              AND json_extract(event.payload_json, '$.id') = run.run_id
              AND event.sequence < fork.fork_sequence
              AND (run.status <> 'rolled_back' OR event.sequence > COALESCE((
                SELECT last_sequence FROM orchestration_v2_projection_metadata
                WHERE projection_name = 'event-log-pruned-through'
              ), 0))
            ORDER BY event.sequence DESC LIMIT 1
          ), run.status) <> 'rolled_back'
          AND (run.status <> 'rolled_back' OR EXISTS (
            SELECT 1 FROM orchestration_events AS rollback
            WHERE rollback.stream_id = fork.source_id
              AND rollback.application_event_version = 2
              AND rollback.event_type = 'run.updated'
              AND json_extract(rollback.payload_json, '$.id') = run.run_id
              AND json_extract(rollback.payload_json, '$.status') = 'rolled_back'
              AND rollback.sequence > fork.fork_sequence
          ))
      ) AS run_ids
      FROM forks AS fork
    )
    UPDATE orchestration_v2_projection_threads AS thread
    SET fork_run_ids_json = membership.run_ids
    FROM memberships AS membership
    WHERE thread.thread_id = membership.thread_id
  `;
});
