import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS claude_trusted_projects (
      project_id TEXT PRIMARY KEY,
      trusted_at TEXT NOT NULL
    )
  `;
});
