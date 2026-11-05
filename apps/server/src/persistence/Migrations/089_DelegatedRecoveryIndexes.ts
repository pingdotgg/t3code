import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_project_linked_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_project_linked_idx
    ON orchestration_v2_projection_threads(project_id, updated_at)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_array_length(payload_json, '$.pullRequests') > 0 ELSE 0 END
  `;

  // Include the parent ID so transfer checks do not reread each child payload.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_subagent_result_idx
    ON orchestration_v2_projection_threads(
      thread_id, CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.lineage.parentThreadId') END
    )
    WHERE CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      AND json_extract(payload_json, '$.forkedFrom.type') = 'node'
      ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_delegated_delivery_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
      ELSE 0 END
  `;
});
