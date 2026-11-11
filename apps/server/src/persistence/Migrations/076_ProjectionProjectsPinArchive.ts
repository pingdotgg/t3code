import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means unpinned and not archived.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN pinned_at TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN archived_at TEXT`;
});
