import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A key names one run of a workflow whatever its version: the row that takes it is that run.
  yield* sql`CREATE UNIQUE INDEX workflow_runs_key ON workflow_runs (workflow, idempotency_key)`;
  // A run its agent gave up on waits for a person: resuming starts the agent's whole job again.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN held INTEGER NOT NULL DEFAULT 0`;
});
