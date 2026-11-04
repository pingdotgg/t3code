import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per plugin directory added to this environment. `record_json` holds the last
  // inspection and the consent; the directory is unique so one folder is one installation.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_installations (
      installation_id TEXT PRIMARY KEY,
      directory TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL
    )
  `;
});
