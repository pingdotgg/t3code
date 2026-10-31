import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per provider machine that became a T3 environment. The record stays after the
  // environment is removed so lifecycle cleanup and usage reporting can still name the machine.
  yield* sql`
    CREATE TABLE sandbox_records (
      environment_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX sandbox_records_deadline_idx
    ON sandbox_records(json_extract(record_json, '$.hardDeadlineAt'))
  `;
});
