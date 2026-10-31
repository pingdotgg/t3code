import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_event_retention (
    thread_id TEXT PRIMARY KEY,
    replay_floor INTEGER NOT NULL
  )`;
});
