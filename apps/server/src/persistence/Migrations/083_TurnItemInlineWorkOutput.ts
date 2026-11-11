import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Thread windows read this flag for every row; scanning payloads on each read
  // dominated thread open. Keep the predicate in step with ProjectionStore.
  yield* sql`
    ALTER TABLE orchestration_v2_projection_turn_items
    ADD COLUMN inline_work_output INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET inline_work_output = 1
    WHERE type = 'dynamic_tool' AND (
      payload_json LIKE '%htmlRender%' OR payload_json LIKE '%t3McpApp%'
      OR payload_json LIKE '%"viewedImagePath"%'
      OR payload_json LIKE '%"toolName":"%delegate_task"%')
  `;
});
