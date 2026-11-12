import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A dispatcher thread keeps one node per delegated task it ever ran. This index lists the
  // ended ones, so a command read can drop them without fetching each node to check its kind.
  // The omitSettledSubagentRecords read in ProjectionStore must spell this predicate the same way.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_ended_subagent_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE kind = 'subagent'
      AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
      AND run_id IS NOT NULL
  `;
});
