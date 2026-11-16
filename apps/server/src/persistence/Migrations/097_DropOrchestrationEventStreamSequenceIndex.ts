import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // idx_orchestration_events_agent_stream_sequence serves its V2 thread reads and
  // idx_orch_events_stream_version its whole-stream reads as well, so it only adds write cost.
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_stream_sequence`;
});
