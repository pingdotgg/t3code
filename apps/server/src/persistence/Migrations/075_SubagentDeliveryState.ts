import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Command reads skip settled subagents by delivery state. Read from payload_json, that parsed
  // every stored prompt; an added column sits after the payload's overflow pages, so the index
  // must cover the whole filter.
  yield* sql`ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN completion_delivery_state TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_subagents
    SET completion_delivery_state = json_extract(payload_json, '$.completionDelivery.state')
    WHERE json_type(payload_json, '$.completionDelivery') IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_settled_idx
    ON orchestration_v2_projection_subagents(thread_id, status, completion_delivery_state, run_id)
  `;
});
