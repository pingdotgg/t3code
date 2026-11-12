import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The run that invoked this one and the wait it sits in, so it hears how this one ended.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT`;
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN parent_wait TEXT`;
  yield* sql`CREATE INDEX workflow_runs_parent ON workflow_runs (parent_run_id)`;
});
