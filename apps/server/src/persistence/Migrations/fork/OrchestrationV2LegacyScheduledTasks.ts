import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import OrchestrationV2 from "../055_OrchestrationV2.ts";

// Fork migration 56 already created a differently shaped `scheduled_tasks`, which upstream's
// `CREATE TABLE IF NOT EXISTS` would silently keep. Move it aside first; ScheduledTaskService
// imports and drops `legacy_scheduled_tasks` at startup, once profiles can be resolved.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "profile_id")) {
    yield* sql`DROP INDEX IF EXISTS idx_scheduled_tasks_next_run`;
    yield* sql`ALTER TABLE scheduled_tasks RENAME TO legacy_scheduled_tasks`;
  }
  yield* OrchestrationV2;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN profile_id TEXT`;
});
