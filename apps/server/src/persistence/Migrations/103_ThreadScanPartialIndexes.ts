import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Periodic limit-recovery, PR-watch and subagent-listing reads otherwise scan every thread row
  // and parse its JSON payload. Keep these predicates identical to ProjectionStore.
  // json_valid keeps a malformed payload writable, as the other payload indexes do.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_limit_recovery_wake_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.limitRecovery.autoResume') = 1
        ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_active_subagent_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
        ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_pull_requests_idx
    ON orchestration_v2_projection_threads(updated_at, thread_id)
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_array_length(payload_json, '$.pullRequests') > 0
        ELSE 0 END
  `;
});
