import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_profiles (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'archived')),
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE bot_profile_revisions (
      thread_id TEXT NOT NULL REFERENCES bot_profiles(thread_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      profile TEXT NOT NULL,
      PRIMARY KEY (thread_id, revision)
    )
  `;
  yield* sql`
    CREATE TABLE bot_drafts (
      id TEXT PRIMARY KEY,
      author_thread_id TEXT NOT NULL REFERENCES bot_profiles(thread_id) ON DELETE CASCADE,
      author_revision INTEGER NOT NULL,
      change_json TEXT NOT NULL,
      decision TEXT CHECK (decision IN ('approved', 'rejected'))
    )
  `;
});
