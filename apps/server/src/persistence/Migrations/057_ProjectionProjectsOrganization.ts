import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Project pins and archives. Null means unpinned and active.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("pinned_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN pinned_at TEXT`;
  }
  if (!existing.has("pin_order_key")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN pin_order_key TEXT`;
  }
  if (!existing.has("archived_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN archived_at TEXT`;
  }
});
