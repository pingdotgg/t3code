import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN forked_from_thread_id TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN forked_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_forked_from_thread_id
    ON projection_threads(forked_from_thread_id)
  `;
});
