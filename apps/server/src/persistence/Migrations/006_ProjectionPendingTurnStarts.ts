import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_turn_starts (
      thread_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
