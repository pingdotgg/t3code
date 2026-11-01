import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE codex_auto_reset_attempts (
      account_fingerprint TEXT PRIMARY KEY,
      reset_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      allowance_cleared INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT,
      next_check_at TEXT
    )
  `;
});
