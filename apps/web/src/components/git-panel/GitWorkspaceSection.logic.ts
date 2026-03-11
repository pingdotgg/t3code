import type { GitStatusResult } from "@t3tools/contracts";

export function resolveCreateWorktreeDisabledReason(input: {
  isPrimaryWorkspace: boolean;
  activeProjectId: string | null;
  gitStatus: GitStatusResult | null;
  repoCwd: string | null;
  activeWorkspaceBranch: string | null;
  isCreating: boolean;
}): string | null {
  const {
    isPrimaryWorkspace,
    activeProjectId,
    gitStatus,
    repoCwd,
    activeWorkspaceBranch,
    isCreating,
  } = input;

  if (!isPrimaryWorkspace) {
    return null;
  }
  if (!activeProjectId) {
    return "No project context";
  }
  if (!gitStatus) {
    return "Status unavailable";
  }
  if (!repoCwd || !activeWorkspaceBranch) {
    return "Checkout branch first";
  }
  if (gitStatus.hasWorkingTreeChanges) {
    return "Commit changes first";
  }
  if (isCreating) {
    return "Creating...";
  }
  return null;
}

export function resolveSyncFromTargetDisabledReason(input: {
  activeTargetBranch: string | null;
  activeWorkspaceBranch: string | null;
  gitStatus: GitStatusResult | null;
  hasConflicts: boolean;
  mergeInProgress: boolean;
  isMerging: boolean;
}): string | null {
  const {
    activeTargetBranch,
    activeWorkspaceBranch,
    gitStatus,
    hasConflicts,
    mergeInProgress,
    isMerging,
  } = input;

  if (!activeTargetBranch) {
    return "No target branch";
  }
  if (activeTargetBranch === activeWorkspaceBranch) {
    return "Already on target branch";
  }
  if (!gitStatus) {
    return "Status unavailable";
  }
  if (!activeWorkspaceBranch) {
    return "Checkout branch first";
  }
  if (hasConflicts) {
    return "Resolve conflicts first";
  }
  if (mergeInProgress) {
    return "Finish current merge";
  }
  if (gitStatus.hasWorkingTreeChanges) {
    return "Commit changes first";
  }
  if (isMerging) {
    return "Merging...";
  }
  return null;
}

export function resolvePrimaryWorkspaceNeedsAttention(gitStatus: GitStatusResult | null): boolean {
  return (
    (gitStatus?.merge.conflictedFiles.length ?? 0) > 0 ||
    gitStatus?.merge.inProgress === true ||
    gitStatus?.hasWorkingTreeChanges === true
  );
}
