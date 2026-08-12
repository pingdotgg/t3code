import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  // Nullable: existing single-root projects have no `.code-workspace` file, and
  // projects opened from a workspace file populate it going forward.
  if (!columns.some((column) => column.name === "workspace_file")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_file TEXT
    `;
  }
});
