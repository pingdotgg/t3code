import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(projection_projects)`.values;
  const hasSortOrderColumn = columns.some((column) => column[1] === "sort_order");

  if (!hasSortOrderColumn) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
    `;
  }
});
