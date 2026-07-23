import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS github_waitpoints (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      originating_turn_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL,
      condition TEXT NOT NULL CHECK (
        condition IN ('checks_settled', 'new_review_activity', 'pull_request_closed')
      ),
      baseline_json TEXT NOT NULL,
      continuation_prompt TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'expired')),
      next_poll_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      delivery_lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_github_waitpoints_due
    ON github_waitpoints (state, next_poll_at, delivery_lease_expires_at)
  `;
});
