import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Startup recovery only needs thread IDs. Keep historical payloads out of
  // these lookups, including root nodes without an attached run.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_unattached_recovery_idx
    ON orchestration_v2_projection_nodes(thread_id, kind, status)
    WHERE run_id IS NULL
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_live_native_idx
    ON orchestration_v2_projection_subagents(thread_id)
    WHERE origin = 'provider_native'
      AND status IN ('pending', 'running', 'waiting')
  `;
});
