import type { GitStatusResult } from "@t3tools/contracts";

export function resolveMergeDisabledReason(input: {
  gitStatus: GitStatusResult | null;
  activeWorkspaceBranch: string | null;
  mergeSourceBranch: string;
  hasConflicts: boolean;
  mergeInProgress: boolean;
  isMerging: boolean;
}): string | null {
  const {
    gitStatus,
    activeWorkspaceBranch,
    mergeSourceBranch,
    hasConflicts,
    mergeInProgress,
    isMerging,
  } = input;

  if (!gitStatus) {
    return "Status unavailable";
  }
  if (!activeWorkspaceBranch) {
    return "Checkout branch first";
  }
  if (mergeSourceBranch.length === 0) {
    return "No branches to merge";
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
