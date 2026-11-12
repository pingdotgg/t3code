import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE thread_folders ADD COLUMN sort_key INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE thread_folders ADD COLUMN rule_json TEXT`;
  yield* sql`ALTER TABLE thread_folders ADD COLUMN auto_file INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE thread_folders ADD COLUMN rule_set_at TEXT`;
  // Existing folders keep their old order: oldest first.
  yield* sql`
    UPDATE thread_folders SET sort_key = (
      SELECT COUNT(*) FROM thread_folders AS older
      WHERE older.created_at < thread_folders.created_at
        OR (older.created_at = thread_folders.created_at AND older.rowid < thread_folders.rowid)
    )
  `;
  // Threads a person or agent placed; auto-file never moves them.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_folder_explicit_moves (
      thread_id TEXT PRIMARY KEY
    )
  `;
  yield* sql`INSERT OR IGNORE INTO thread_folder_explicit_moves SELECT thread_id FROM thread_folder_members`;
});
