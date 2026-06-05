import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_thread_links (
      source TEXT NOT NULL,
      external_thread_id TEXT NOT NULL,
      t3_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      primary_external_message_id TEXT,
      url TEXT,
      muted INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, external_thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_thread_links_t3_thread
    ON external_thread_links(t3_thread_id, source, external_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_thread_links_project
    ON external_thread_links(project_id, source, external_thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_event_receipts (
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, event_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_event_receipts_updated
    ON external_event_receipts(source, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_artifact_links (
      kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      t3_thread_id TEXT NOT NULL,
      url TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, external_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_artifact_links_t3_thread
    ON external_artifact_links(t3_thread_id, kind, external_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_delivery_receipts (
      source TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      status TEXT NOT NULL,
      external_message_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, delivery_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_delivery_receipts_updated
    ON external_delivery_receipts(source, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_chat_sdk_subscriptions (
      thread_id TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_chat_sdk_locks (
      thread_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_chat_sdk_locks_expires
    ON external_chat_sdk_locks(expires_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_chat_sdk_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_chat_sdk_cache_expires
    ON external_chat_sdk_cache(expires_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_chat_sdk_lists (
      key TEXT PRIMARY KEY,
      values_json TEXT NOT NULL,
      expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_chat_sdk_lists_expires
    ON external_chat_sdk_lists(expires_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_chat_sdk_queues (
      thread_id TEXT PRIMARY KEY,
      entries_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;
});
