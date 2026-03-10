import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fresh databases created from migration 005 already include this column, so
  // replaying migration 014 must be a no-op rather than relying on driver-specific
  // duplicate-column error handling.
  const columns = yield* sql`PRAGMA table_info(projection_projects)`.values;
  const hasThreadGroupOrderColumn = columns.some(
    (column) => column[1] === "thread_group_order_json",
  );

  if (!hasThreadGroupOrderColumn) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN thread_group_order_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
