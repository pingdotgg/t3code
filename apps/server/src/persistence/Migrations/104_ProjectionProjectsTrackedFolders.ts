import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Earlier builds of this change shipped the column under another migration id.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (columns.some((column) => column.name === "tracked_folders_json")) return;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN tracked_folders_json TEXT NOT NULL DEFAULT '[]'
  `;
});
