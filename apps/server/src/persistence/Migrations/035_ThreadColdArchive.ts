import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Registers already-archived threads for conversion to cold storage.
 *
 * The migration deliberately only creates durable work records. Compression
 * and filesystem I/O are performed by the background lifecycle worker after
 * startup so a large existing archive cannot hold the schema migration or UI
 * thread hostage.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_archive_manifests (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      archive_version INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      original_bytes INTEGER NOT NULL DEFAULT 0,
      compressed_bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_archive_manifests_root_status
    ON thread_archive_manifests(root_thread_id, status, archived_at, thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_storage_maintenance (
      task TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO thread_storage_maintenance (task, status, updated_at)
    VALUES ('compact-legacy-thread-storage', 'pending', CURRENT_TIMESTAMP)
  `;

  yield* sql`
    INSERT OR IGNORE INTO thread_archive_manifests (
      thread_id,
      root_thread_id,
      status,
      archive_version,
      archived_at,
      updated_at
    )
    SELECT
      thread_id,
      thread_id,
      'pending',
      1,
      archived_at,
      CURRENT_TIMESTAMP
    FROM projection_threads
    WHERE archived_at IS NOT NULL
      AND deleted_at IS NULL
  `;
});
