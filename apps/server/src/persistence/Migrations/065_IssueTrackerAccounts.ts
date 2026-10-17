import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_tracker_accounts (
    tracker TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    host TEXT NOT NULL,
    account_id TEXT NOT NULL,
    PRIMARY KEY (tracker, connection_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE issue_tracker_bindings_next (
    project_id TEXT NOT NULL,
    tracker TEXT NOT NULL,
    scope TEXT NOT NULL,
    host TEXT,
    connection_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, tracker),
    FOREIGN KEY (tracker, connection_id) REFERENCES issue_tracker_accounts (tracker, connection_id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO issue_tracker_bindings_next (project_id, tracker, scope, host, updated_at)
    SELECT project_id, tracker, scope, host, updated_at FROM issue_tracker_bindings`;
  yield* sql`DROP TABLE issue_tracker_bindings`;
  yield* sql`ALTER TABLE issue_tracker_bindings_next RENAME TO issue_tracker_bindings`;
});
