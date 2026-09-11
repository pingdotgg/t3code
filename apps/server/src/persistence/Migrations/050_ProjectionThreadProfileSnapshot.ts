import * as Effect from "effect/Effect";
import activeOrderKey from "./049_ProjectionThreadsActiveOrderKey.ts";
import branchPullRequest from "./048_ProjectionThreadBranchPullRequest.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  yield* branchPullRequest;
  // Early agents builds used migration 49; repair the upstream column when it was skipped.
  yield* activeOrderKey;
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "profile_snapshot_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN profile_snapshot_json TEXT
    `;
  }
});
