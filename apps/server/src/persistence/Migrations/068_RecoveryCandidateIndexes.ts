import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Startup recovery reads these predicates once per boot. Without the
  // partial indexes the predicates scan every run and every thread.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_delegated_completion_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE json_valid(payload_json)
      AND json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_subagent_recovery_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE json_valid(payload_json)
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      AND json_extract(payload_json, '$.forkedFrom.type') = 'node'
  `;
});
