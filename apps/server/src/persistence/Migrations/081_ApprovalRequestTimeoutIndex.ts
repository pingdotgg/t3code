import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runtime_requests_timeout_idx
    ON orchestration_v2_projection_runtime_requests(created_at, runtime_request_id)
    WHERE status = 'pending'
      AND kind NOT IN ('user_input', 'auth_refresh', 'dynamic_tool_call')
  `;
});
