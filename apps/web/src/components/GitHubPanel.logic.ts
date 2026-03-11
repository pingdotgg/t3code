import type { GitStatusResult } from "@t3tools/contracts";

export type WorkspaceStatusLevel = "success" | "warning" | "error" | "neutral" | "info";

export function deriveWorkspaceStatusInfo(input: {
  hasConflicts: boolean;
  mergeInProgress: boolean;
  hasChanges: boolean;
}): { level: WorkspaceStatusLevel; label: string } {
  const { hasConflicts, mergeInProgress, hasChanges } = input;
  if (hasConflicts) {
    return { level: "error", label: "Conflicts" };
  }
  if (mergeInProgress) {
    return { level: "warning", label: "Merging" };
  }
  if (hasChanges) {
    return { level: "warning", label: "Dirty" };
  }
  return { level: "success", label: "Clean" };
}

export function buildCommitToBranchLabel(branchName: string | null): string {
  return branchName ? `Commit to ${branchName}` : "Commit to branch";
}

export function resolveCommitToBranchDisabledReason(input: {
  gitStatus: GitStatusResult | null;
  hasConflicts: boolean;
  isBusy: boolean;
}): string | null {
  const { gitStatus, hasConflicts, isBusy } = input;
  if (!gitStatus) {
    return "Status unavailable";
  }
  if (gitStatus.branch === null) {
    return "Checkout branch first";
  }
  if (isBusy) {
    return "Action in progress";
  }
  if (hasConflicts) {
    return "Resolve conflicts before committing";
  }
  if (!gitStatus.hasWorkingTreeChanges) {
    return "Nothing to commit";
  }
  return null;
}

export function resolveDedicatedWorkspaceActionState(input: {
  gitStatus: GitStatusResult | null;
  hasConflicts: boolean;
  mergeInProgress: boolean;
  isClosing: boolean;
  hasRepoContext: boolean;
  hasThreadContext: boolean;
}): {
  closeDisabledReason: string | null;
  showDiscardAction: boolean;
  discardDisabledReason: string | null;
} {
  const { gitStatus, hasConflicts, mergeInProgress, isClosing, hasRepoContext, hasThreadContext } =
    input;

  if (!hasRepoContext) {
    return {
      closeDisabledReason: "Repo unavailable",
      showDiscardAction: false,
      discardDisabledReason: "Repo unavailable",
    };
  }

  if (!hasThreadContext) {
    return {
      closeDisabledReason: "Thread unavailable",
      showDiscardAction: false,
      discardDisabledReason: "Thread unavailable",
    };
  }

  if (isClosing) {
    return {
      closeDisabledReason: "Closing...",
      showDiscardAction: true,
      discardDisabledReason: "Closing...",
    };
  }

  if (!gitStatus) {
    return {
      closeDisabledReason: "Status unavailable",
      showDiscardAction: false,
      discardDisabledReason: "Status unavailable",
    };
  }

  if (hasConflicts) {
    return {
      closeDisabledReason: "Commit or discard changes first",
      showDiscardAction: true,
      discardDisabledReason: null,
    };
  }

  if (mergeInProgress) {
    return {
      closeDisabledReason: "Commit or discard changes first",
      showDiscardAction: true,
      discardDisabledReason: null,
    };
  }

  if (gitStatus.hasWorkingTreeChanges) {
    return {
      closeDisabledReason: "Commit or discard changes first",
      showDiscardAction: true,
      discardDisabledReason: null,
    };
  }

  return {
    closeDisabledReason: null,
    showDiscardAction: false,
    discardDisabledReason: "No uncommitted changes to discard",
  };
}

export function resolveDefaultMergeSourceBranch(input: {
  branchNames: ReadonlyArray<string>;
  activeWorkspaceBranch: string | null;
  activeTargetBranch: string | null;
  currentMergeSourceBranch: string;
}): string {
  const { branchNames, activeWorkspaceBranch, activeTargetBranch, currentMergeSourceBranch } = input;
  if (branchNames.length === 0 || !activeWorkspaceBranch) {
    return "";
  }

  if (
    currentMergeSourceBranch.length > 0 &&
    branchNames.includes(currentMergeSourceBranch) &&
    currentMergeSourceBranch !== activeWorkspaceBranch
  ) {
    return currentMergeSourceBranch;
  }

  if (
    activeTargetBranch &&
    branchNames.includes(activeTargetBranch) &&
    activeTargetBranch !== activeWorkspaceBranch
  ) {
    return activeTargetBranch;
  }

  return branchNames.find((branchName) => branchName !== activeWorkspaceBranch) ?? "";
}

export function buildResolveConflictPrompt(input: {
  workspacePath: string | null;
  sourceBranch: string | null;
  mergeSourceBranch: string | null;
  conflictedFiles: ReadonlyArray<string>;
}): string {
  const workspaceLine = input.workspacePath ? `Workspace path: ${input.workspacePath}` : null;
  const sourceLine = input.sourceBranch ? `Current branch: ${input.sourceBranch}` : null;
  const mergeLine = input.mergeSourceBranch
    ? `Merge source branch: ${input.mergeSourceBranch}`
    : null;
  const fileLines =
    input.conflictedFiles.length > 0
      ? ["Conflicted files:", ...input.conflictedFiles.map((file) => `- ${file}`)]
      : ["Conflicted files: check git status for details."];

  return [
    "Resolve the current git merge conflict in this workspace.",
    workspaceLine,
    sourceLine,
    mergeLine,
    ...fileLines,
    "Preserve the intended changes from both sides where possible.",
    "Inspect the current git status, resolve the conflict markers, and leave the repository in a completed merge state.",
    "Call out any risky tradeoffs before changing behavior.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildPrimaryWorkspaceResolutionPrompt(input: {
  workspacePath: string | null;
  takeoverBranch: string | null;
  conflictedFiles: ReadonlyArray<string>;
  changedFiles: ReadonlyArray<string>;
}): string {
  const workspaceLine = input.workspacePath ? `Primary checkout path: ${input.workspacePath}` : null;
  const takeoverLine = input.takeoverBranch
    ? `Branch to activate after close: ${input.takeoverBranch}`
    : null;
  const blockedByConflicts = input.conflictedFiles.length > 0;
  const fileLines = blockedByConflicts
    ? ["Conflicted files:", ...input.conflictedFiles.map((file) => `- ${file}`)]
    : input.changedFiles.length > 0
      ? ["Changed files:", ...input.changedFiles.map((file) => `- ${file}`)]
      : ["Inspect git status to find the blocking changes."];

  return [
    "Resolve the primary checkout so the dedicated workspace can be closed safely.",
    workspaceLine,
    takeoverLine,
    blockedByConflicts
      ? "The primary checkout has merge conflicts that block switching branches."
      : input.takeoverBranch
        ? `The primary checkout has uncommitted changes that block switching to ${input.takeoverBranch}.`
        : "The primary checkout has uncommitted changes that block switching branches.",
    ...fileLines,
    "Inspect the current git status, then either commit, discard, or resolve the blocking changes.",
    "Leave the primary checkout clean when finished.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
