import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { ProjectService, type ProjectServiceError } from "./ProjectService.ts";

export const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const projectMutationOperation = (
  projects: ProjectService["Service"],
  mutation: ProjectMutation,
) =>
  mutation.type === "project.create"
    ? projects.create({
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
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      })
    : mutation.type === "project.update"
      ? projects.update({
          commandId: mutation.commandId,
          projectId: mutation.projectId,
          ...(mutation.title === undefined ? {} : { title: mutation.title }),
          ...(mutation.workspaceRoot === undefined
            ? {}
            : { workspaceRoot: mutation.workspaceRoot }),
          ...(mutation.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: mutation.defaultModelSelection }),
          ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
          ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
          ...(mutation.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
          ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
          ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
        })
      : projects.delete({
          commandId: mutation.commandId,
          projectId: mutation.projectId,
          ...(mutation.force === undefined ? {} : { force: mutation.force }),
        });

export const projectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projects.snapshot.pipe(
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const operation = projectMutationOperation(projects, args.payload);
          return yield* startup.enqueueCommand(operation).pipe(Effect.catch(failProjectMutation));
        }),
      );
  }),
);
