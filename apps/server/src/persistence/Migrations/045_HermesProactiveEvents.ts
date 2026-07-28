import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable, capability-gated storage for Hermes events that happen without an
 * attached T3 turn. The source checkpoint and event page commit together.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE hermes_proactive_sources (
      source_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      capability_state TEXT NOT NULL
        CHECK (capability_state IN ('ready', 'degraded')),
      diagnostic_code TEXT NOT NULL
        CHECK (
          diagnostic_code IN (
            'ready',
            'missing_capability_inventory',
            'missing_durable_global_cursor',
            'missing_stable_event_ids'
          )
        ),
      missing_capabilities_json TEXT NOT NULL,
      checkpoint_cursor TEXT,
      checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_sequence >= 0),
      last_checked_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider_instance_id, profile_key)
    )
  `;

  yield* sql`
    CREATE TABLE hermes_proactive_events (
      event_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL
        REFERENCES hermes_proactive_sources(source_id) ON DELETE CASCADE,
      external_event_id TEXT NOT NULL,
      external_cursor TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      project_id TEXT,
      thread_id TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      UNIQUE (source_id, external_event_id)
    )
  `;

  yield* sql`
    CREATE INDEX hermes_proactive_events_source_cursor_idx
    ON hermes_proactive_events(source_id, external_cursor, event_id)
  `;

  yield* sql`
    CREATE TABLE hermes_notification_outbox (
      outbox_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE
        REFERENCES hermes_proactive_events(event_id) ON DELETE CASCADE,
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'processing', 'retry', 'delivered', 'dead_letter')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      CHECK (
        (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX hermes_notification_outbox_claim_idx
    ON hermes_notification_outbox(state, available_at, created_at, outbox_id)
    WHERE state IN ('pending', 'retry', 'processing')
  `;

  yield* sql`
    CREATE TABLE hermes_proactive_work_items (
      work_item_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE
        REFERENCES hermes_proactive_events(event_id) ON DELETE CASCADE,
      project_id TEXT,
      thread_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'dismissed')),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX hermes_proactive_work_items_status_idx
    ON hermes_proactive_work_items(status, occurred_at DESC, work_item_id)
  `;

  yield* sql`
    CREATE TABLE hermes_in_app_notifications (
      notification_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE
        REFERENCES hermes_proactive_events(event_id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL UNIQUE
        REFERENCES hermes_proactive_work_items(work_item_id) ON DELETE CASCADE,
      project_id TEXT,
      thread_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'dismissed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX hermes_in_app_notifications_status_idx
    ON hermes_in_app_notifications(status, created_at DESC, notification_id)
  `;
});
