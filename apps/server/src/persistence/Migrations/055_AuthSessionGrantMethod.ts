import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Bootstrap grant a session was exchanged from ("desktop-bootstrap" or
// "one-time-token"). Server-written only; sessions issued directly (CLI,
// relay, dev token) and rows older than this column stay NULL.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!columns.some((column) => column.name === "grant_method")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN grant_method TEXT
    `;
  }
});
