import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork: legacy component preview config column. Kept for parity with fork
 * databases that already carry it; the column is reset by migration 037 and
 * unused by current code.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "preview_config_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN preview_config_json TEXT
    `;
  }
});
