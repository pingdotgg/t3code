import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per file a reader has cleared on a host that keeps no record of its own. `revision`
  // is what the file was when it was cleared, so a push that changes it is reported as changed
  // rather than silently left ticked. It is nullable because a host asked mid-press does not
  // always answer: null is no baseline to compare against, which is not the same as the empty
  // string, which is the host saying the head has nothing of the file. Unticking deletes the row:
  // absent is the resting state, and a table of "not viewed" rows would grow with every diff
  // anybody scrolled past.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_files_viewed (
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      viewer TEXT NOT NULL,
      path TEXT NOT NULL,
      revision TEXT,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (provider, host, repository, number, viewer, path)
    ) WITHOUT ROWID
  `;
});
