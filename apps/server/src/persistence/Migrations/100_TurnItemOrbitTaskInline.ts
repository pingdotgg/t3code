import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep Orbit task-create receipts out of deferred work groups so their inline
  // cards and thread Tasks panel entries appear in the first snapshot.
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET inline_work_output = 1
    WHERE type = 'dynamic_tool'
      AND inline_work_output = 0
      AND (
        payload_json LIKE '%"orbitTask"%'
        OR payload_json LIKE '%"toolName":"%orbit%task-create"%'
        OR payload_json LIKE '%"toolName":"%orbit%task_create"%'
      )
  `;
});
