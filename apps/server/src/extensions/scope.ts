import {
  ExtensionOperationError,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import type { ExtensionViewContext } from "@t3tools/contracts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";

export function toSdkContext(value: ViewContext | ExtensionViewContext): ViewContext {
  return {
    resource: {
      namespace: value.resource.namespace,
      id: value.resource.id,
      environmentId: value.resource.environmentId,
      ...(value.resource.projectId === undefined ? {} : { projectId: value.resource.projectId }),
      ...(value.resource.threadId === undefined ? {} : { threadId: value.resource.threadId }),
    },
    client: value.client,
    ...(value.workspaceRevision === undefined
      ? {}
      : { workspaceRevision: value.workspaceRevision }),
  };
}

export function makeExtensionScopeResolver(dependencies: {
  readonly environmentId: string;
  readonly projects: {
    getById(input: {
      projectId: ProjectId;
    }): Effect.Effect<
      Option.Option<Pick<ProjectionProject, "projectId" | "workspaceRoot" | "deletedAt">>,
      ProjectionRepositoryError
    >;
  };
  readonly threads: {
    getById(input: {
      threadId: ThreadId;
    }): Effect.Effect<
      Option.Option<Pick<ProjectionThread, "projectId" | "worktreePath" | "deletedAt">>,
      ProjectionRepositoryError
    >;
  };
}) {
  return Effect.fn("EnvironmentExtensions.resolveScope")(function* (
    input: ViewContext | ExtensionViewContext,
    derive = false,
  ) {
    const context = toSdkContext(input);
    const fail = (detail: string) => new ExtensionOperationError({ operation: "scope", detail });
    if (context.resource.environmentId !== dependencies.environmentId)
      return yield* fail("Extension environment does not match this server.");
    let projectId = context.resource.projectId;
    let worktreePath: string | null = null;
    if (context.resource.threadId) {
      const found = yield* dependencies.threads
        .getById({ threadId: ThreadId.make(context.resource.threadId) })
        .pipe(Effect.mapError(() => fail("Cannot resolve extension thread.")));
      if (Option.isNone(found) || found.value.deletedAt !== null)
        return yield* fail("Extension thread is unavailable.");
      if (projectId !== undefined && projectId !== found.value.projectId)
        return yield* fail("Extension thread does not belong to this project.");
      projectId = found.value.projectId;
      worktreePath = found.value.worktreePath;
    }
    if (!projectId) return yield* fail("Extension tools require a project scope.");
    const found = yield* dependencies.projects
      .getById({ projectId: ProjectId.make(projectId) })
      .pipe(Effect.mapError(() => fail("Cannot resolve extension project.")));
    if (Option.isNone(found) || found.value.deletedAt !== null)
      return yield* fail("Extension project is unavailable.");
    const workspaceRevision = extensionWorkspaceRevision(found.value.workspaceRoot, worktreePath);
    if (!derive && context.workspaceRevision !== workspaceRevision)
      return yield* fail("Extension workspace context is stale.");
    return {
      cwd: worktreePath ?? found.value.workspaceRoot,
      worktreePath,
      context: { ...context, resource: { ...context.resource, projectId }, workspaceRevision },
    };
  });
}
