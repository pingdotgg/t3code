import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ProjectionStore.listActiveShellIndex reads these fields from the index instead of parsing
  // every active thread's payload. Keep the expressions identical to that query's.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_active_shell_idx
    ON orchestration_v2_projection_threads(
      updated_at,
      thread_id,
      project_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.sideChat') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledOverride') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledAt') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinnedAt') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinOrderKey') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedUntil') END,
      CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.pullRequests[0]') END
    )
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_threads_pending_tasks_idx
    ON orchestration_v2_projection_provider_threads(thread_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
      ELSE 0 END
  `;
});
