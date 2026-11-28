import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_recaps (
      thread_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      covered_message_id TEXT,
      source_signature TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
