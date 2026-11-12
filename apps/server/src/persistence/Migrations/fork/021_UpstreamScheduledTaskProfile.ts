import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The fork adds `profile_id` inside its replacement for upstream migration 55, which a
 * database upstream already migrated past 55 skips. Fork migration 3 then left its own
 * index on upstream's table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "profile_id")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN profile_id TEXT`;
  }
  yield* sql`DROP INDEX IF EXISTS idx_scheduled_tasks_next_run`;
});
