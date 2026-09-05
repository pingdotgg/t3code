/**
 * Branch shown on a thread list row. The stored `thread.branch` always wins:
 * it is the ref the thread was created against and the value the PR badge
 * compares. A local thread (`worktreePath == null`) with a null branch was
 * created before the live checkout was known (status pending, detached HEAD,
 * non-repo, or offline queue) — the server never backfills that null, so the
 * row falls back to the live checkout, mirroring web's header
 * (`resolveBranchToolbarValue`). Worktree threads never fall back: their cwd
 * is isolated and its checkout may be a temporary `t3-*` placeholder.
 */
export function resolveThreadDisplayBranch(input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly liveCheckoutBranch: string | null;
}): string | null {
  const stored = input.branch?.trim();
  if (stored) {
    return stored;
  }
  if (input.worktreePath !== null) {
    return null;
  }
  const live = input.liveCheckoutBranch?.trim();
  return live ? live : null;
}
