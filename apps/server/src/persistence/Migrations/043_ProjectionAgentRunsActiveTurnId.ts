import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs agent run projections created by the first version of migration 041,
 * which predated active turn correlation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_agent_runs)
  `;

  if (!columns.some((column) => column.name === "active_turn_id")) {
    yield* sql`
      ALTER TABLE projection_agent_runs
      ADD COLUMN active_turn_id TEXT
    `;
  }
});
