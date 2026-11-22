import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_collections (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE bot_work_runs (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      collection_id TEXT NOT NULL REFERENCES bot_collections(id),
      run_id TEXT,
      status TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_bot_work_active ON bot_work_runs(status) WHERE status IN ('waiting', 'running')`;
  yield* sql`CREATE UNIQUE INDEX idx_bot_work_run ON bot_work_runs(run_id) WHERE run_id IS NOT NULL`;
  yield* sql`CREATE INDEX idx_bot_work_root ON bot_work_runs(root_id)`;
  yield* sql`CREATE INDEX idx_bot_work_collection ON bot_work_runs(collection_id)`;
});
