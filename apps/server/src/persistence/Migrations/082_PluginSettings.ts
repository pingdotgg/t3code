import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Saved plugin setting values per installation, secrets excepted.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_settings (
      installation_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (installation_id, key)
    )
  `;
  // Secrets whose value may be in the server secret store. A row is written before its file and
  // deleted after it, so cleanup can always find the file; `saved` is 1 once the value is complete
  // and 0 while it is written or deleted.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_setting_secrets (
      installation_id TEXT NOT NULL,
      key TEXT NOT NULL,
      saved INTEGER NOT NULL,
      PRIMARY KEY (installation_id, key)
    )
  `;
  // Each installation's private key-value storage; `bytes` is the value's encoded size for quotas.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      installation_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (installation_id, key)
    )
  `;
});
