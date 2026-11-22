import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bot_drafts ADD COLUMN grant_source TEXT`;
  yield* sql`ALTER TABLE bot_drafts ADD COLUMN activated_id TEXT`;
  yield* sql`
    CREATE TABLE bot_activation_grants (
      thread_id TEXT NOT NULL REFERENCES bot_profiles(thread_id) ON DELETE CASCADE,
      resource TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (thread_id, resource, source)
    )
  `;
});
