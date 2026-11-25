import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Every set of hooks a person approved for a project stays approved, so checkouts of one
  // project that declare different hooks do not take each other's approval away.
  yield* sql`
    CREATE TABLE IF NOT EXISTS claude_project_hook_approvals (
      project_id TEXT NOT NULL,
      hooks_hash TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (project_id, hooks_hash)
    )
  `;
});
