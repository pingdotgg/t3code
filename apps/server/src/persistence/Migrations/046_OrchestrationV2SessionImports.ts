import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Tracks threads created by importing an existing provider session (Claude
 * Code or Codex) by its external id. One row per imported thread; used to
 * re-sync the provider's on-disk transcript into the thread on read, and to
 * refuse importing the same external session twice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_session_imports (
      thread_id TEXT PRIMARY KEY,
      driver TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      source_modified_at TEXT,
      last_synced_at TEXT NOT NULL,
      imported_message_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX orchestration_v2_session_imports_external_idx
    ON orchestration_v2_session_imports(driver, external_id)
  `;
});
