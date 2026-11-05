import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Capabilities read each provider instance's latest finished run; without this, every
  // call walked all runs.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_instance_finished_idx
    ON orchestration_v2_projection_runs(provider_instance_id, completed_at, run_id)
    WHERE status IN ('completed', 'failed')
  `;
});
