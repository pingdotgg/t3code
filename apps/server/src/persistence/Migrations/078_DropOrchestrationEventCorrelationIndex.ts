import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // No query filters events by correlation_id, so this index only adds write
  // and storage cost. The column and its values stay.
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
});
