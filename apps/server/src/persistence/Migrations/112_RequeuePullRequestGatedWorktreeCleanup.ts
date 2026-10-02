import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Archive cleanup no longer waits for a merged pull request: a clean worktree
 * is removed while its branch ref keeps every commit. Requeue jobs that were
 * parked only by the retired pull-request gate, plus removal failures caused by
 * already-missing directories, so the reactor re-evaluates them under the
 * content-based policy. Every other review state is left untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE worktree_cleanup_jobs
    SET
      status = 'waiting',
      attempt_count = 0,
      next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      last_reason = NULL,
      last_error = NULL
    WHERE source = 'archive'
      AND status IN ('waiting', 'needs-attention')
      AND last_reason IN (
        'no-pull-request',
        'pull-request-worktree-branch-mismatch',
        'pull-request-closed-unmerged',
        'pull-request-not-merged',
        'pull-request-unavailable',
        'removal-failed'
      )
  `;
});
