import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE external_task_links (
    project_id TEXT NOT NULL, thread_id TEXT NOT NULL, task_url TEXT NOT NULL,
    task_key TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL, PRIMARY KEY(project_id, thread_id, task_url),
    UNIQUE(project_id, task_url)
  )`;
  // Record intent before contacting a host. An ambiguous result is never replayed.
  yield* sql`CREATE TABLE external_task_writes (
    operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
});
