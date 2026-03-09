import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN vcs_backend TEXT NOT NULL DEFAULT 'git'
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN ref_name TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN ref_kind TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN workspace_path TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE projection_threads
    SET
      vcs_backend = COALESCE(vcs_backend, 'git'),
      ref_name = COALESCE(ref_name, branch),
      ref_kind = COALESCE(ref_kind, CASE WHEN branch IS NULL THEN NULL ELSE 'branch' END),
      workspace_path = COALESCE(workspace_path, worktree_path)
  `;
});
