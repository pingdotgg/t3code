// Pure helpers for tracking the relationship between a chat (thread) and the
// git branch it was first run against. Side-effect free so they can live
// outside React and be tested in isolation.

import type { VcsStatusResult } from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

export interface ThreadBranchMismatch {
  readonly threadBranch: string;
  readonly currentBranch: string;
}

/**
 * Returns the branch we should auto-link a chat to when it has none yet.
 * Only fills nulls — never silently overwrites an existing link, since the
 * whole point of branch tracking is to make the user the decision-maker
 * when chat-branch and checkout drift apart.
 */
export function resolveThreadBranchAutoLink(input: {
  readonly threadBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
}): { readonly branch: string } | null {
  if (input.threadBranch !== null) return null;
  const candidate = input.gitStatus?.refName ?? null;
  if (candidate === null) return null;
  // Skip ephemeral t3code/<hash> worktree-bootstrap refs — binding to one
  // would re-trigger the mismatch UX as soon as the user moves on.
  if (isTemporaryWorktreeBranch(candidate)) return null;
  return { branch: candidate };
}

/**
 * Compares a chat's stored branch to the working tree's current branch.
 * Returns mismatch info when they disagree so the chat header can offer
 * "checkout chat branch" vs. "relink chat to current branch".
 */
export function resolveThreadBranchMismatch(input: {
  readonly threadBranch: string | null;
  readonly currentBranch: string | null;
}): ThreadBranchMismatch | null {
  if (!input.threadBranch || !input.currentBranch) return null;
  if (input.threadBranch === input.currentBranch) return null;
  // Ignore the brief window where a worktree is bootstrapping on a
  // temporary t3code/<hash> ref — that's not a real divergence.
  if (
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.currentBranch)
  ) {
    return null;
  }
  return {
    threadBranch: input.threadBranch,
    currentBranch: input.currentBranch,
  };
}
