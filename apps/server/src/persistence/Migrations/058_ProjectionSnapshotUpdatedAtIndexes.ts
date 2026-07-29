import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The shell snapshot reads MAX(updated_at) over these tables to keep tracking
  // freshness for soft-deleted rows it no longer loads. Without an index
  // beginning with updated_at those aggregates are full scans;
  // projection_projects already has one from migration 005.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_updated_at
    ON projection_threads(updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_updated_at
    ON projection_thread_sessions(updated_at)
  `;
});
