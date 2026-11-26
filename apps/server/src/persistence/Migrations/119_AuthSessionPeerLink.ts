import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!columns.some((column) => column.name === "peer_link")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN peer_link INTEGER NOT NULL DEFAULT 0
    `;
  }
});
