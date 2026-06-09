import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_kind TEXT NOT NULL DEFAULT 'root'`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN root_thread_id TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_turn_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_item_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_activity_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN provider_thread_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN title_seed TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_depth INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_started_at TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_completed_at TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_status TEXT`;

  yield* sql`
    UPDATE projection_threads
    SET root_thread_id = thread_id
    WHERE root_thread_id = ''
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_relation
    ON projection_threads(parent_thread_id, subagent_status, subagent_started_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_root_relation
    ON projection_threads(root_thread_id, deleted_at, archived_at, thread_id)
  `;
});
