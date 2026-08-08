import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records the repository root's stash separately from the worktree's.
 *
 * One hop can stash two checkouts — the repository root and the worktree the
 * thread lands in. Sharing a single column means the later stash overwrites
 * the earlier one, and crash recovery pops only one of them while the other
 * set of the user's changes stays parked forever. The root's directory is
 * stored alongside it because `apply_cwd` names the worktree, not the root.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_v2_thread_handoffs ADD COLUMN root_stash_ref TEXT
  `;
  yield* sql`
    ALTER TABLE orchestration_v2_thread_handoffs ADD COLUMN root_cwd TEXT
  `;
});
