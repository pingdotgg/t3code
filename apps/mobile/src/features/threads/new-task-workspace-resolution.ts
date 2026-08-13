import { type VcsRef } from "@t3tools/client-runtime/state/vcs";

export type WorkspaceMode = "local" | "worktree";

export type ResolvedWorkspace = {
  readonly mode: WorkspaceMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
};

/**
 * Resolve the workspace a New Thread should actually start with, so the send
 * action is never blocked on configuration the user has not (or cannot) fill
 * in. Only a worktree thread with no chosen branch needs resolving; everything
 * else starts as-is.
 *
 * A worktree needs a base branch. When none was picked — the repo default is
 * still loading, or no ref is flagged default/current — the best available
 * branch is chosen (default → current → first local branch). When no branch is
 * known at all (branches not loaded, or not a branchy repo) it falls back to a
 * current-checkout thread, which needs no branch, rather than leaving the task
 * unstartable.
 *
 * `worktreePath` is passed through untouched: consumers null it out in worktree
 * mode (a fresh worktree is created), so it only matters for the local
 * fallback, where the caller's value is the right one to keep.
 */
export function resolveStartWorkspace(
  input: ResolvedWorkspace,
  branches: {
    /** All refs, including remote-only ones (a default may only exist as origin/<default>). */
    readonly all: ReadonlyArray<VcsRef>;
    /** Local (non-remote) refs, the only ones a worktree can be based on directly. */
    readonly available: ReadonlyArray<VcsRef>;
  },
): ResolvedWorkspace {
  if (input.mode !== "worktree" || input.branch !== null) {
    return input;
  }

  const preferredBranch =
    branches.all.find((branch) => branch.isDefault) ??
    branches.available.find((branch) => branch.current) ??
    branches.available[0] ??
    null;

  if (!preferredBranch) {
    return { mode: "local", branch: null, worktreePath: input.worktreePath };
  }

  return { mode: "worktree", branch: preferredBranch.name, worktreePath: input.worktreePath };
}
