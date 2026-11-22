import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Covers ProjectionStore.listActiveShellIndex and selectShellPendingSubagentRows without
  // scanning settled subagent history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_pending_delivery_idx
    ON orchestration_v2_projection_subagents(thread_id)
    WHERE origin = 'app_owned'
      AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
      AND completion_delivery_state IN ('pending', 'claimed')
  `;
});
