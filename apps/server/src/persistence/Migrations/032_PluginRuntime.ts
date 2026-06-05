import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_documents (
      plugin_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      document_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, collection, document_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_documents_collection_updated
    ON plugin_documents(plugin_id, collection, updated_at DESC, document_id)
  `;
});
