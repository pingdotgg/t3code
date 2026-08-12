import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Worker config JSON on projected workflow runs.
 *
 * Divergent or partially applied ledgers can already contain
 * `worker_config_json` while still replaying migration 43 (for example a
 * high-water mark stuck at 40 with the schema effect already present). Guard
 * the ALTER so startup remains idempotent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_workflow_runs)
  `;

  if (!hasColumn(columns, "worker_config_json")) {
    yield* sql`
      ALTER TABLE projection_workflow_runs
      ADD COLUMN worker_config_json TEXT NOT NULL DEFAULT '{}'
    `;
  }
});
