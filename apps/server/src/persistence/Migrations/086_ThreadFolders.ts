import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Sidebar folders are presentation, not thread history, so they are plain
  // rows rather than events. Membership lives on the folder.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_folders (
      folder_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_folder_members (
      thread_id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES thread_folders (folder_id) ON DELETE CASCADE,
      added_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_folder_members_folder
    ON thread_folder_members (folder_id)
  `;
});
