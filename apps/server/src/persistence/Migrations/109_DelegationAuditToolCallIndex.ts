import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_audit_thread_tool_call_turn_sequence
    ON delegation_audit_events(
      source_thread_id,
      json_extract(context_json, '$.toolCallId'),
      source_turn_id,
      sequence DESC
    )
  `;
});
