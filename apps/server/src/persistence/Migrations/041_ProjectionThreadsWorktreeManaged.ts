import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // Threads that predate the marker keep 0: a worktree whose provenance is
  // unknown is treated as the user's, so driver clean-tree guards stay on.
  if (!columns.some((column) => column.name === "worktree_managed")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN worktree_managed INTEGER NOT NULL DEFAULT 0
    `;
  }
});
