import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Reopening one thread must not revive other bindings of the same shared session.
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_session_bindings ADD COLUMN payload_json TEXT`;
  yield* sql`UPDATE orchestration_v2_projection_provider_session_bindings
    SET payload_json = (SELECT session.payload_json
      FROM orchestration_v2_projection_provider_sessions AS session
      WHERE session.provider_session_id = orchestration_v2_projection_provider_session_bindings.provider_session_id)`;
});
