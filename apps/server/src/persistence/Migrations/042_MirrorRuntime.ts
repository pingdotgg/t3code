import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Host side: per-mirrored-project sync watermark and queued apply-back.
  // Runtime state, not event-sourced (same category as provider_session_runtime).
  yield* sql`
    CREATE TABLE IF NOT EXISTS mirror_sync_runtime (
      project_id TEXT PRIMARY KEY,
      last_synced_snapshot_oid TEXT,
      last_synced_at TEXT,
      last_branches_json TEXT,
      pending_apply_json TEXT,
      conflict_paths_json TEXT
    )
  `;

  // Origin side: which local folders are attached to which host projects.
  // The peer bearer token lives in the secret store, never in this table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS mirror_links (
      project_id TEXT PRIMARY KEY,
      host_url TEXT NOT NULL,
      local_root TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
