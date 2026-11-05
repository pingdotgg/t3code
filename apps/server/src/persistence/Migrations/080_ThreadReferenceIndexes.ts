import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Unlike message search these cover streaming and subagent messages too.
  yield* sql`
    CREATE INDEX orchestration_v2_message_thread_links_idx
    ON orchestration_v2_projection_messages(thread_id)
    WHERE instr(payload_json, 't3-thread://') > 0
       OR instr(payload_json, 'app.t3.codes/threads/') > 0
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_message_context_refs_idx
    ON orchestration_v2_projection_messages(thread_id)
    WHERE json_type(payload_json, '$.context.records') = 'array'
  `;
});
