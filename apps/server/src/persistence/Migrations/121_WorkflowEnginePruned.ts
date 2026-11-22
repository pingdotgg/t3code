import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // When an ended run's engine journal was deleted; the run's own rows stay.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN engine_pruned_at TEXT`;
  yield* sql`
    CREATE INDEX workflow_runs_unpruned ON workflow_runs (ended_at)
    WHERE ended_at IS NOT NULL AND engine_pruned_at IS NULL
  `;
});
