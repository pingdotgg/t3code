import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means not yet derived; readers fall back to the payload predicate, so no backfill.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN persistent_output INTEGER`;
});
