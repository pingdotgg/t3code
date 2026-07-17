import type { OrchestrationProjectShell, OrchestrationThread, VcsRef } from "@t3tools/contracts";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
} from "@t3tools/shared/git";

export type NewThreadWorkspaceMode = "current" | "new-worktree";

export interface NewThreadContext {
  readonly projectIndex: number;
  readonly workspaceMode: NewThreadWorkspaceMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/**
 * Match the web UI's contextual new-thread behavior: start in the selected
 * thread's project/workspace when there is one, otherwise use the first project
 * and the server's configured default environment mode.
 */
export function resolveNewThreadContext(input: {
  readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id">>;
  readonly thread: Pick<OrchestrationThread, "projectId" | "branch" | "worktreePath"> | null;
  readonly defaultEnvironmentMode: "local" | "worktree";
}): NewThreadContext {
  const contextualProjectIndex = input.thread
    ? input.projects.findIndex((project) => project.id === input.thread?.projectId)
    : -1;
  const projectIndex = contextualProjectIndex >= 0 ? contextualProjectIndex : 0;

  if (contextualProjectIndex >= 0 && input.thread) {
    return {
      projectIndex,
      workspaceMode: "current",
      branch: input.thread.branch,
      worktreePath: input.thread.worktreePath,
    };
  }

  return {
    projectIndex,
    workspaceMode: input.defaultEnvironmentMode === "worktree" ? "new-worktree" : "current",
    branch: null,
    worktreePath: null,
  };
}

/** Prefer explicit context, then the checked-out/default branch, then the first ref. */
export function resolveInitialBranch(
  refs: ReadonlyArray<VcsRef>,
  preferredBranch: string | null,
): string | null {
  if (preferredBranch && refs.some((ref) => ref.name === preferredBranch)) {
    return preferredBranch;
  }
  return (
    refs.find((ref) => ref.current)?.name ??
    refs.find((ref) => ref.isDefault)?.name ??
    refs[0]?.name ??
    preferredBranch
  );
}

export type NewThreadBranchSelection =
  | {
      readonly kind: "select-base";
      readonly branch: string;
      readonly worktreePath: null;
    }
  | {
      readonly kind: "reuse-worktree";
      readonly branch: string;
      readonly worktreePath: string | null;
    }
  | {
      readonly kind: "switch-checkout";
      readonly branch: string;
      readonly checkoutCwd: string;
      readonly worktreePath: string | null;
    };

/**
 * Resolve a ref choice using the same rules as the web branch toolbar.
 * New-worktree drafts only select a base; current-checkout drafts either reuse
 * an existing worktree or switch the selected checkout before first send.
 */
export function resolveNewThreadBranchSelection(input: {
  readonly workspaceMode: NewThreadWorkspaceMode;
  readonly projectCwd: string;
  readonly currentWorktreePath: string | null;
  readonly ref: VcsRef;
}): NewThreadBranchSelection {
  if (input.workspaceMode === "new-worktree") {
    return {
      kind: "select-base",
      branch: input.ref.name,
      worktreePath: null,
    };
  }

  const target = resolveBranchSelectionTarget({
    activeProjectCwd: input.projectCwd,
    activeWorktreePath: input.currentWorktreePath,
    refName: input.ref,
  });
  const branch = input.ref.isRemote
    ? deriveLocalBranchNameFromRemoteRef(input.ref.name)
    : input.ref.name;

  if (target.reuseExistingWorktree) {
    return {
      kind: "reuse-worktree",
      branch,
      worktreePath: target.nextWorktreePath,
    };
  }

  return {
    kind: "switch-checkout",
    branch,
    checkoutCwd: target.checkoutCwd,
    worktreePath: target.nextWorktreePath,
  };
}

export type NewThreadValidationError =
  | "missing-project"
  | "missing-message"
  | "missing-model"
  | "missing-base-branch";

export function validateNewThread(input: {
  readonly hasProject: boolean;
  readonly message: string;
  readonly hasModelSelection: boolean;
  readonly workspaceMode: NewThreadWorkspaceMode;
  readonly branch: string | null;
}): NewThreadValidationError | null {
  if (!input.hasProject) return "missing-project";
  if (input.message.trim().length === 0) return "missing-message";
  if (!input.hasModelSelection) return "missing-model";
  if (input.workspaceMode === "new-worktree" && !input.branch?.trim()) {
    return "missing-base-branch";
  }
  return null;
}

export function newThreadValidationMessage(error: NewThreadValidationError): string {
  switch (error) {
    case "missing-project":
      return "Add or select a project before creating a thread.";
    case "missing-message":
      return "Describe the task before creating the thread.";
    case "missing-model":
      return "Select a model before creating the thread.";
    case "missing-base-branch":
      return "Select a base branch before creating a new worktree.";
  }
}
