import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS delegation_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      attempt_id TEXT,
      source_thread_id TEXT NOT NULL,
      source_turn_id TEXT,
      source_message_id TEXT,
      child_thread_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      evidence_status TEXT NOT NULL
        CHECK (evidence_status IN ('complete', 'redacted', 'truncated', 'unavailable', 'expired')),
      redacted INTEGER NOT NULL DEFAULT 0,
      context_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_thread_sequence
    ON delegation_audit_events(source_thread_id, sequence DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_operation_sequence
    ON delegation_audit_events(operation_id, sequence DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_attempt_sequence
    ON delegation_audit_events(source_thread_id, attempt_id, sequence DESC)
  `;
});
