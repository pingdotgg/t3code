import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "repo_roots")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repo_roots TEXT NOT NULL DEFAULT '[]'
    `;
  }

  yield* sql`
    UPDATE projection_projects
    SET repo_roots = json_array(workspace_root)
    WHERE repo_roots IS NULL OR repo_roots = '' OR repo_roots = '[]'
  `;
});
