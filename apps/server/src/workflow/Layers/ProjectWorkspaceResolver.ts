import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectWorkspaceResolver,
  ProjectWorkspaceResolverError,
  type ProjectWorkspaceResolverShape,
} from "../Services/ProjectWorkspaceResolver.ts";

const toResolverError = (message: string) => (cause: unknown) =>
  new ProjectWorkspaceResolverError({ message, cause });

const make = Effect.gen(function* () {
  const projects = yield* ProjectionSnapshotQuery;

  const resolve: ProjectWorkspaceResolverShape["resolve"] = (projectId) =>
    projects.getProjectShellById(projectId).pipe(
      Effect.mapError(toResolverError(`Failed to resolve workspace for project ${projectId}`)),
      Effect.flatMap((project) =>
        Option.match(project, {
          onNone: () =>
            Effect.fail(
              new ProjectWorkspaceResolverError({
                message: `Project ${projectId} was not found`,
              }),
            ),
          onSome: (shell) => Effect.succeed(shell.workspaceRoot as string),
        }),
      ),
    );

  return { resolve } satisfies ProjectWorkspaceResolverShape;
});

export const ProjectWorkspaceResolverLive = Layer.effect(ProjectWorkspaceResolver, make);
