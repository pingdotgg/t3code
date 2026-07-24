import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sidebar_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO sidebar_state (id, revision)
    VALUES (1, 0)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sidebar_pinned_threads (
      project_key TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (project_key, thread_key),
      UNIQUE (project_key, position)
    )
  `;
});
