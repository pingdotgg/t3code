import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Host-owned, NOT a plugin migration: settings must work for a plugin that never
  // declares the `database` capability, so the plugin cannot own this table.
  //
  // values_json holds the ENCODED shape, never decoded Type values: the form edits
  // encoded data and Effect transformations can decode to something whose re-encode
  // differs, which would make the next read fail to decode.
  //
  // revision is the optimistic-concurrency token (writes CAS on it). updated_at is
  // epoch ms and is informational only — it is NOT safe as a concurrency token,
  // because two writers can read and write within the same millisecond.
  //
  // schema_fingerprint records which schema shape produced values_json, so an
  // upgrade that changes the schema can detect incompatibility and preserve the
  // stored data rather than silently misreading it.
  yield* sql`
    CREATE TABLE plugin_settings (
      plugin_id TEXT PRIMARY KEY,
      values_json TEXT NOT NULL,
      schema_fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});
