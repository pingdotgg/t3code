import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_thread_operation_turn_sequence
    ON delegation_audit_events(
      source_thread_id,
      operation_id,
      source_turn_id,
      sequence DESC
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_thread_turn_sequence
    ON delegation_audit_events(source_thread_id, source_turn_id, sequence DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_child_sequence
    ON delegation_audit_events(child_thread_id, sequence DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_operation_attempt_event
    ON delegation_audit_events(operation_id, attempt_id, event_type)
  `;
});
