import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionCore from "./005_Projections.ts";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Durable thread pull-request association column.
 *
 * Divergent ledgers can advance past migration 005 without creating
 * `projection_threads`. Ensure the canonical projection tables exist before
 * inspecting and altering the threads table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* ProjectionCore;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;

  if (!hasColumn(columns, "pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pull_request_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
});
