import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN worktree_branch_naming_json TEXT NOT NULL DEFAULT '{"mode":"auto"}'
  `;

  yield* sql`
    UPDATE projection_threads
    SET worktree_branch_naming_json = '{"mode":"auto"}'
    WHERE worktree_branch_naming_json IS NULL OR trim(worktree_branch_naming_json) = ''
  `;
});
