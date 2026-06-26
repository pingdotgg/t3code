import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Per-root worktree map for isolated runs (Phase 4 / decision D3). An isolated
  // run fans out one worktree per repo root; the JSON array stores
  // `{ repoRoot, worktreePath }` entries. Existing single-root threads default
  // to `[]` and continue to rely on the singular `worktree_path` shim until a
  // new isolated run repopulates the map.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN worktrees_json TEXT NOT NULL DEFAULT '[]'
  `.pipe(Effect.catch(() => Effect.void));
});
