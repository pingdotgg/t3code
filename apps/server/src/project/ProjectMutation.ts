import { type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ProjectConflictError,
  ProjectNotEmptyError,
  ProjectOperationError,
  type ProjectService,
} from "./ProjectService.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update">;

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});

const isProjectNotEmptyError = Schema.is(ProjectNotEmptyError);
const isProjectConflictError = Schema.is(ProjectConflictError);
const isProjectOperationError = Schema.is(ProjectOperationError);

/** The client-facing message for a failed mutation: specific when the user can act on it. */
export function projectMutationFailureMessage(cause: unknown): string {
  if (isProjectNotEmptyError(cause) || isProjectConflictError(cause)) {
    return cause.message;
  }
  // A missing or non-directory path, e.g. a mistyped folder when moving a project.
  if (
    isProjectOperationError(cause) &&
    cause.operation === "normalize-workspace" &&
    cause.cause instanceof Error
  ) {
    return cause.cause.message;
  }
  return "Failed to mutate project.";
}
