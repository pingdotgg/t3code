import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A webhook that skips most of what it brings leaves tens of thousands of runs. The runs list, its
// badge counts and the sweep must not read every one of them on each look.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Nothing orders runs of one status by when they last changed; lists of one order by start.
  yield* sql`DROP INDEX IF EXISTS workflow_runs_status`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_status_started ON workflow_runs (status, started_at)
  `;
  // Must say exactly what the runs list says, or SQLite does not see that it covers the list.
  yield* sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_listed ON workflow_runs (started_at)
    WHERE NOT (status = 'skipped' AND parent_run_id IS NULL)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_unfinished ON workflow_runs (workflow, version)
    WHERE ended_at IS NULL
  `;
});
