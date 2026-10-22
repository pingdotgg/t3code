import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Its own table, like scheduled task webhook secrets, so the signing secret
  // never reaches the event log or the thread read model clients receive.
  yield* sql`CREATE TABLE thread_watches (
    thread_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, url)
  )`;
});
