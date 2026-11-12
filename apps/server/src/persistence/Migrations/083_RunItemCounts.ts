import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A thread's shell shows how many items it holds. ProjectionStore keeps these counts as items
  // and runs are written, so the shell no longer counts every item of a long thread on each update.
  // Items without a run count under run_id ''. `counted` is 1 for a run that exists and was not
  // rolled back, and for items without a run.
  yield* sql`
    CREATE TABLE orchestration_v2_projection_run_item_counts (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      counted INTEGER NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_run_item_counts (thread_id, run_id, item_count, counted)
    SELECT counts.thread_id, counts.run_id, counts.item_count,
      CASE WHEN counts.run_id = '' OR run.status <> 'rolled_back' THEN 1 ELSE 0 END
    FROM (
      SELECT thread_id, COALESCE(run_id, '') AS run_id, COUNT(*) AS item_count
      FROM orchestration_v2_projection_turn_items
      GROUP BY thread_id, COALESCE(run_id, '')
    ) AS counts
    LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = counts.run_id
  `;
});
