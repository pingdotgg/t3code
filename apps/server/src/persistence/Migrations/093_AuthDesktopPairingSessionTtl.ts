import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_pairing_links)`;
  if (!columns.some((column) => column.name === "desktop_session_ttl_days")) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN desktop_session_ttl_days INTEGER
      CHECK (desktop_session_ttl_days BETWEEN 1 AND 365)`;
  }
});
