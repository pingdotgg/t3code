import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS lan_gateway_peers (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      http_base_url TEXT NOT NULL,
      added_at TEXT NOT NULL
    )
  `;
});
