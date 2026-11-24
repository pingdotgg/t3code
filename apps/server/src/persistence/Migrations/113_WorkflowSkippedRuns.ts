import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The sweep keeps each workflow's latest skipped runs and deletes the rest, newest first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_skipped
    ON workflow_runs (workflow, started_at)
    WHERE status = 'skipped' AND parent_run_id IS NULL
  `;
  // A skipped run ends without anything to clean up, so the payload it started with is not read
  // again. Webhook-driven servers kept hundreds of megabytes of these a day.
  yield* sql`
    UPDATE workflow_runs SET input_json = NULL
    WHERE status = 'skipped' AND parent_run_id IS NULL AND input_json IS NOT NULL
  `;
});
