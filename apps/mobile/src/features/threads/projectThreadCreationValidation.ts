import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class ProjectThreadTaskRequiredError extends Schema.TaggedErrorClass<ProjectThreadTaskRequiredError>()(
  "ProjectThreadTaskRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
    environmentMode: Schema.Literals(["local", "worktree"]),
  },
) {
  override get message(): string {
    return "Enter a task before starting the thread.";
  }
}

export class ProjectThreadBaseBranchRequiredError extends Schema.TaggedErrorClass<ProjectThreadBaseBranchRequiredError>()(
  "ProjectThreadBaseBranchRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return "Select a base branch before creating a worktree.";
  }
}

export const ProjectThreadCreationValidationError = Schema.Union([
  ProjectThreadTaskRequiredError,
  ProjectThreadBaseBranchRequiredError,
]);
export type ProjectThreadCreationValidationError = typeof ProjectThreadCreationValidationError.Type;

/**
 * Branch recorded on a thread created from the new-task composer. An explicit
 * picker choice always wins. An untouched current-checkout draft records the
 * ref that is actually checked out, so the thread's PR badge and branch label
 * match the live git status instead of staying blank. A detached HEAD, a
 * non-repository project, or a status that has not arrived stays null rather
 * than fabricating a branch. Only the online creation path resolves a
 * checkout; a queued task cannot know the checkout it will drain against.
 */
export function resolveProjectThreadCreationBranch(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly selectedBranch: string | null;
  readonly currentCheckoutBranch: string | null;
}): string | null {
  if (input.selectedBranch !== null) {
    return input.selectedBranch;
  }
  return input.workspaceMode === "local" ? input.currentCheckoutBranch : null;
}

export function validateProjectThreadCreation(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly environmentMode: "local" | "worktree";
  readonly branch: string | null;
  readonly initialMessageText: string;
}): ProjectThreadCreationValidationError | null {
  if (input.initialMessageText.trim().length === 0) {
    return new ProjectThreadTaskRequiredError({
      environmentId: input.environmentId,
      projectId: input.projectId,
      environmentMode: input.environmentMode,
    });
  }
  if (input.environmentMode === "worktree" && !input.branch) {
    return new ProjectThreadBaseBranchRequiredError({
      environmentId: input.environmentId,
      projectId: input.projectId,
    });
  }
  return null;
}
