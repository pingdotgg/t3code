import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existingTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'auth_sessions'
  `;
  const tableNames = new Set(existingTables.map((table) => table.name));

  if (tableNames.has("auth_sessions")) {
    const sessionColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(auth_sessions)
    `;

    if (!sessionColumns.some((column) => column.name === "last_connected_at")) {
      yield* sql`
        ALTER TABLE auth_sessions
        ADD COLUMN last_connected_at TEXT
      `;
    }
  }
});
