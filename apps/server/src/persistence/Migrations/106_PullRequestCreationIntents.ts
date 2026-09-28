import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_creation_intents (
      action_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      local_branch TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      head_selector TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      pull_request_json TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS pull_request_creation_intents_due_idx
    ON pull_request_creation_intents (next_attempt_at, requested_at)
  `;
});
