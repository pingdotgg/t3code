import { DEFAULT_VCS_TERMINOLOGY, type VcsTerminology } from "@t3tools/shared/vcs";

type WorkspaceMode = "local" | "worktree";

export function resolveNewTaskWorkspaceLabel(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly worktreePath: string | null;
  readonly terminology?: VcsTerminology;
}): string {
  const terminology = input.terminology ?? DEFAULT_VCS_TERMINOLOGY;
  if (input.workspaceMode === "worktree") {
    return `New ${terminology.workspaceNoun}`;
  }
  return input.worktreePath
    ? `Current ${terminology.workspaceNoun}`
    : `Current ${terminology.currentRefFallback}`;
}

export function resolveNewTaskBranchWorktreePath(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly projectCwd: string;
  readonly branchWorktreePath: string | null | undefined;
}): string | null {
  if (
    input.workspaceMode === "worktree" ||
    !input.branchWorktreePath ||
    input.branchWorktreePath === input.projectCwd
  ) {
    return null;
  }
  return input.branchWorktreePath;
}

export function resolveNewTaskLocalWorkspaceSelection(input: {
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string;
}): {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly awaitsCurrentBranch: boolean;
} {
  const currentBranch = input.branches.find((branch) => branch.current) ?? null;
  if (!currentBranch) {
    return {
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    };
  }

  return {
    branch: currentBranch.name,
    worktreePath: resolveNewTaskBranchWorktreePath({
      workspaceMode: "local",
      projectCwd: input.projectCwd,
      branchWorktreePath: currentBranch.worktreePath,
    }),
    awaitsCurrentBranch: false,
  };
}

export function resolveNewTaskBranchLabel(input: {
  readonly branchName: string | null;
  readonly startFromOrigin: boolean;
  readonly workspaceMode: WorkspaceMode;
  readonly terminology?: VcsTerminology;
}): string {
  if (!input.branchName) {
    return `Choose ${(input.terminology ?? DEFAULT_VCS_TERMINOLOGY).refNoun}`;
  }

  if (input.workspaceMode === "local") {
    return input.branchName;
  }

  const baseRef = input.startFromOrigin ? `origin/${input.branchName}` : input.branchName;
  return `From ${baseRef}`;
}

export function shouldCheckoutNewTaskBranch(input: {
  readonly branchIsCurrent: boolean;
  readonly branchWorktreePath: string | null | undefined;
  readonly workspaceMode: WorkspaceMode;
}): boolean {
  return input.workspaceMode === "local" && !input.branchIsCurrent && !input.branchWorktreePath;
}
