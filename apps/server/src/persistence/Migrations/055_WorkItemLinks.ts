import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS work_item_links (
      issue_provider TEXT NOT NULL,
      issue_url TEXT NOT NULL,
      issue_repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_title TEXT NOT NULL,
      pull_request_provider TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      pull_request_repository TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL,
      pull_request_title TEXT NOT NULL,
      PRIMARY KEY (issue_provider, issue_url, pull_request_provider, pull_request_url)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_work_item_links_pull_request
    ON work_item_links(pull_request_provider, pull_request_url)
  `;
});
