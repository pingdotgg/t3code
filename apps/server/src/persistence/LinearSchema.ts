import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Creates the Linear tables. Like the Pipelines schema it runs after the numbered migrations instead
 * of taking an id in their ladder, so a fork-only id cannot collide with a later upstream one. Every
 * statement is idempotent, so it runs on each start.
 */
export const ensureLinearSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // thread_url and comment_body_hash are server-internal: the first lets the pipeline reactor
  // rebuild its comment after a restart, the second lets it skip edits that would change nothing.
  yield* sql`
    CREATE TABLE IF NOT EXISTS linear_issue_links (
      link_id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      team_id TEXT NOT NULL,
      project_id TEXT,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('thread', 'pipeline_run')),
      target_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      comment_id TEXT,
      comment_mode TEXT NOT NULL CHECK (comment_mode IN ('none', 'thread', 'pipeline')),
      state_moved_to TEXT,
      thread_url TEXT NOT NULL DEFAULT '',
      comment_body_hash TEXT,
      UNIQUE (issue_id, target_kind, target_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linear_issue_links_issue
    ON linear_issue_links(issue_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linear_issue_links_thread
    ON linear_issue_links(thread_id)
  `;
});
