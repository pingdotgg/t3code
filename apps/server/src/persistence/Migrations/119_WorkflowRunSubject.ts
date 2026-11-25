import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The one thing a run declares it is about. Kind and key find runs of a subject, the url finds
  // them by the address a person has; the JSON is what a client needs to show and open it.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN subject_kind TEXT`;
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN subject_key TEXT`;
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN subject_url TEXT`;
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN subject_json TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_subject ON workflow_runs (subject_key)
    WHERE subject_key IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_subject_url ON workflow_runs (subject_url)
    WHERE subject_url IS NOT NULL
  `;
});
