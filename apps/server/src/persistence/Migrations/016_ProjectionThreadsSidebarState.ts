import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(projection_threads)`.values;
  const hasSidebarHiddenAtColumn = columns.some((column) => column[1] === "sidebar_hidden_at");
  const hasDismissedSidebarKeysColumn = columns.some(
    (column) => column[1] === "dismissed_sidebar_keys_json",
  );

  if (!hasSidebarHiddenAtColumn) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidebar_hidden_at TEXT
    `;
  }

  if (!hasDismissedSidebarKeysColumn) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN dismissed_sidebar_keys_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
