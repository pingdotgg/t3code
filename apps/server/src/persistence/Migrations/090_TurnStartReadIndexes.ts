import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep this predicate identical to ProjectionStore's TURN_START_COMMAND_MESSAGE, or turn
  // starts parse every user message of the thread again.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_messages_turn_start_command_idx
    ON orchestration_v2_projection_messages(thread_id)
    WHERE role = 'user' AND (
      lower(trim(json_extract(payload_json, '$.text'), char(32, 9, 10, 13, 11, 12, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) = '/compact'
      OR trim(json_extract(payload_json, '$.text'), char(32, 9, 10, 13, 11, 12, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) GLOB '/goal*'
    )
  `;
  // Turn start routes completed subagents by these ids without reading their payloads.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_routing_idx
    ON orchestration_v2_projection_subagents(thread_id, status, subagent_id, child_thread_id, provider_thread_id)
  `;
});
