import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A place a run holds or waits for in a named pool, in the order runs asked. `state` is
  // `queued`, `held`, `away` (held when its run paused) or `returning` (that run was resumed).
  yield* sql`
    CREATE TABLE workflow_pool_places (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      pool TEXT NOT NULL,
      size INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      UNIQUE (run_id, name)
    )
  `;
  yield* sql`CREATE INDEX workflow_pool_places_pool ON workflow_pool_places (pool, state, seq)`;
});
