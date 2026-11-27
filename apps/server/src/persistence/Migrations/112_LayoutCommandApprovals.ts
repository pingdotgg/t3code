import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One approved text per project and command: approving a new text replaces the old one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS layout_command_approvals (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (project_id, kind)
    )
  `;
});
