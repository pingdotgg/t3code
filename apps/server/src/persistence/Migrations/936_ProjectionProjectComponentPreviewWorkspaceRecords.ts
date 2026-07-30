import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork: per-workspace component preview records projected onto projects.
 * The column name matches fork databases that created it under the old
 * migration numbering, so re-running here is a no-op for them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "preview_workspace_records_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN preview_workspace_records_json TEXT DEFAULT '[]'
    `;
  }
});
