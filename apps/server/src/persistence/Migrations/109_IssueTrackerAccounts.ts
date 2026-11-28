import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Accounts added beside a standalone tracker's first one. The first keeps no row and binds
  // with a null account_id, so bindings saved before this migration still read the same.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_tracker_accounts (
      tracker TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tracker, account_id)
    ) WITHOUT ROWID
  `;
  yield* sql`ALTER TABLE issue_tracker_bindings ADD COLUMN account_id TEXT`;
});
