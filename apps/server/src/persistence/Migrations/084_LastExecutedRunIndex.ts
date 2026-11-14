import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The shell's last executed run lookup sorts every run of the thread. This index carries
  // that order and the same predicate the lookup filters on. A database that already has
  // the index keeps it, so a hand-applied one does not fail the migration.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_last_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued'
      AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
  `;
});
