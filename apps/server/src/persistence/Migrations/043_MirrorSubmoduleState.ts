import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(mirror_sync_runtime)
  `;

  // Host side: per-project mirror sync watermarks for nested repositories
  // (submodules and dangling gitlinks), plus any soft-failure warnings
  // recorded while cascading a seed/sync/apply-back into them.
  if (!columns.some((column) => column.name === "submodule_state_json")) {
    yield* sql`
      ALTER TABLE mirror_sync_runtime
      ADD COLUMN submodule_state_json TEXT
    `;
  }
  if (!columns.some((column) => column.name === "submodule_warnings_json")) {
    yield* sql`
      ALTER TABLE mirror_sync_runtime
      ADD COLUMN submodule_warnings_json TEXT
    `;
  }
});
