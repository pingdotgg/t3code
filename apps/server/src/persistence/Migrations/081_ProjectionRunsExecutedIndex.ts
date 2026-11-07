import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Matches the shell's latest-executed-run ordering, so it reads the newest rows instead of sorting every run.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL), completed_at, ordinal, run_id
    )
  `;
});
