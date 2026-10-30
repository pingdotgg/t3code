import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE task_documents (
    task_document_id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    file_id TEXT UNIQUE,
    locator_version INTEGER NOT NULL DEFAULT 0,
    registered INTEGER NOT NULL DEFAULT 1
  )`;
});
