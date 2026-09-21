import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Creates the complete cold-storage lifecycle schema and queues existing
 * archived and deleted threads for background processing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_archive_manifests (
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
    CREATE INDEX idx_thread_archive_manifests_root_status
    ON thread_archive_manifests(root_thread_id, status, archived_at, thread_id)
  `;

  yield* sql`
    CREATE TABLE thread_storage_maintenance (
      task TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    )
  `;

  yield* sql`
    INSERT INTO thread_storage_maintenance (task, status, updated_at)
    VALUES ('compact-legacy-thread-storage', 'pending', CURRENT_TIMESTAMP)
  `;

  yield* sql`
    CREATE TABLE thread_cleanup_queue (
      thread_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  yield* sql`
    INSERT INTO thread_archive_manifests (
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

  yield* sql`
    INSERT INTO thread_cleanup_queue (thread_id, reason, created_at)
    SELECT thread_id, 'deleted', CURRENT_TIMESTAMP
    FROM projection_threads
    WHERE deleted_at IS NOT NULL
  `;
});
