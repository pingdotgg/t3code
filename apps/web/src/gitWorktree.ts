const WORKTREE_BRANCH_PREFIX = "t3code";

export function buildTemporaryWorktreeBranchName(): string {
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}
