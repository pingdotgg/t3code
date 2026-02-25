import type { GitBranch, ThreadId } from "@t3tools/contracts";

interface DeriveSyncedLocalBranchInput {
  activeThreadId: ThreadId | undefined;
  activeWorktreePath: string | null;
  envMode: "local" | "worktree";
  activeThreadBranch: string | null;
  queryBranches: ReadonlyArray<GitBranch> | undefined;
}

export function deriveSyncedLocalBranch({
  activeThreadId,
  activeWorktreePath,
  envMode,
  activeThreadBranch,
  queryBranches,
}: DeriveSyncedLocalBranchInput): string | null {
  if (!activeThreadId || activeWorktreePath || envMode !== "local") {
    return null;
  }

  const currentBranch = queryBranches?.find((branch) => branch.current);
  if (!currentBranch || currentBranch.name === activeThreadBranch) {
    return null;
  }

  return currentBranch.name;
}
