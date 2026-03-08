import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'local'
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN remote_host_id TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN remote_host_label TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_hosts (
      remote_host_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      user TEXT NOT NULL,
      identity_file TEXT,
      ssh_config_host TEXT,
      helper_command TEXT NOT NULL,
      helper_version TEXT,
      last_connection_attempt_at TEXT,
      last_connection_succeeded_at TEXT,
      last_connection_failed_at TEXT,
      last_connection_status TEXT NOT NULL DEFAULT 'unknown',
      last_connection_error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_remote_hosts_label
    ON remote_hosts(label)
  `;
});
