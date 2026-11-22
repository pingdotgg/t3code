import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep these expressions identical to ProjectionStore's shell worktree and family filters.
  // json_valid keeps a malformed payload writable, as the other payload indexes do.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_worktree_path_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.worktreePath') END
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_root_thread_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END
    )
  `;
  // Shell item counts read only a run's status; the primary key would load the whole row.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_run_status_idx
    ON orchestration_v2_projection_runs(run_id, status)
  `;
});
