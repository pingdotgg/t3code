import type { OrchestrationProjectShell, OrchestrationThread, VcsRef } from "@t3tools/contracts";

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
