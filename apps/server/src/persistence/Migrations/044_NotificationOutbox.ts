/**
 * 044_NotificationOutbox — the notification outbox and its cursor.
 *
 * Detected notification edges are rows in a projection table, not domain events:
 * a notification is a view over the domain, not a fact about it. The table is
 * rebuildable by re-running the `NotificationReactor` from sequence 0 —
 * `identity_key` as the primary key is what makes that replay idempotent.
 *
 * Every candidate edge gets a row, fired or not, so the row is the audit record:
 * "why did it fire" is the triggering event id plus the phase pair, "why didn't
 * it" is `detection_verdict` / `deciding_guard` / `transport_outcome`.
 *
 * The reactor's cursor reuses the existing `projection_state` table under the
 * projector key `notifications.outbox`; no new cursor table is needed.
 */

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      identity_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_id TEXT,
      request_id TEXT,
      project_title TEXT NOT NULL,
      thread_title TEXT NOT NULL,
      headline TEXT NOT NULL,
      detail TEXT,
      triggering_event_id TEXT NOT NULL,
      triggering_sequence INTEGER NOT NULL,
      previous_phase TEXT,
      next_phase TEXT,
      detection_verdict TEXT NOT NULL,
      deciding_guard TEXT NOT NULL,
      transport_outcome TEXT NOT NULL,
      transport_name TEXT,
      detected_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  // Terminal kinds are mutually exclusive per turn: one turn produces either a
  // `turn-completed` row or a `turn-failed` row, never both. `failed` wins at
  // detection time; this index is the belt-and-braces that turns a slip into a
  // recorded `already-notified` instead of a second notification.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_terminal_turn
    ON notification_outbox(thread_id, turn_id)
    WHERE turn_id IS NOT NULL AND kind IN ('turn-completed', 'turn-failed')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_sequence
    ON notification_outbox(triggering_sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_thread_detected
    ON notification_outbox(thread_id, detected_at)
  `;
});
