import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a run touched, once per thing: a later touch updates the row and adds its step.
  yield* sql`
    CREATE TABLE workflow_run_references (
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      address_json TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      state TEXT,
      steps_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      noted_at TEXT NOT NULL,
      PRIMARY KEY (run_id, kind, key)
    )
  `;
});
