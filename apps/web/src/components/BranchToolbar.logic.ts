import type { GitBranch, ThreadId } from "@t3tools/contracts";

interface DeriveSyncedLocalBranchInput {
  activeThreadId: ThreadId | undefined;
  activeWorktreePath: string | null;
  envMode: "local" | "worktree";
  activeThreadBranch: string | null;
  queryBranches: ReadonlyArray<GitBranch> | undefined;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
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
