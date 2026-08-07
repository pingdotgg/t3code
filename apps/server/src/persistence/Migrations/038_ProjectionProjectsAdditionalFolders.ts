import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "additional_folders_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN additional_folders_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  // SQLite backfills existing rows as part of ADD COLUMN ... DEFAULT, so this
  // only matters when re-running against a database whose column was added
  // without the default.
  yield* sql`
    UPDATE projection_projects
    SET additional_folders_json = '[]'
    WHERE additional_folders_json IS NULL OR TRIM(additional_folders_json) = ''
  `;
});
