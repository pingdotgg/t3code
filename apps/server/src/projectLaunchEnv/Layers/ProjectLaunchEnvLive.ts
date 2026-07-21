import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectLaunchEnv } from "../Services/ProjectLaunchEnv.ts";
import { mergeResolvedProjectLaunchEnv } from "../projectLaunchEnvUtils.ts";
import {
  ProjectLaunchEnvProjectNotFoundError,
  ProjectLaunchEnvProjectStatError,
  ProjectLaunchEnvThreadLookupError,
} from "../Services/ProjectLaunchEnvErrors.ts";

export const makeProjectLaunchEnv = Effect.fn("makeProjectLaunchEnv")(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const resolve: ProjectLaunchEnv["Service"]["resolve"] = (input) =>
    Effect.succeed(
      mergeResolvedProjectLaunchEnv({
        t3Home: serverConfig.baseDir,
        ...(input.extraEnv !== undefined ? { extraEnv: input.extraEnv } : {}),
        context: {
          projectRoot: input.projectRoot,
          projectId: String(input.projectId),
          threadId: String(input.threadId),
          worktreePath: input.worktreePath ?? undefined,
        },
      }),
    );

  const resolveForThread: ProjectLaunchEnv["Service"]["resolveForThread"] = Effect.fn(
    "ProjectLaunchEnv.resolveForThread",
  )(function* (input) {
    const threadOption = yield* projectionSnapshotQuery
      .getThreadShellById(ThreadId.make(input.threadId))
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectLaunchEnvThreadLookupError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              cause,
            }),
        ),
      );

    const { projectId, worktreePath } = yield* Option.match(threadOption, {
      onSome: (thread) =>
        Effect.succeed({
          projectId: thread.projectId,
          worktreePath: input.worktreePath !== undefined ? input.worktreePath : thread.worktreePath,
        }),
      onNone: () => {
        if (input.projectId === undefined) {
          return Effect.fail(
            new ProjectLaunchEnvThreadLookupError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          );
        }

        return Effect.succeed({
          projectId: input.projectId,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        });
      },
    });

    const projectOption = yield* projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectLaunchEnvProjectStatError({
            projectId: String(projectId),
            cause,
          }),
      ),
    );

    const project = yield* Option.match(projectOption, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          new ProjectLaunchEnvProjectNotFoundError({
            projectId: String(projectId),
          }),
        ),
    });

    const env: Record<string, string> = yield* resolve({
      ...(input.extraEnv !== undefined ? { extraEnv: input.extraEnv } : {}),
      projectRoot: project.workspaceRoot,
      projectId: project.id,
      threadId: input.threadId,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
    });

    const result = {
      projectId,
      worktreePath,
      env,
    };
    return result;
  });

  return {
    resolve,
    resolveForThread,
  } satisfies ProjectLaunchEnv["Service"];
});

export const ProjectLaunchEnvLive = Layer.effect(ProjectLaunchEnv, makeProjectLaunchEnv());
