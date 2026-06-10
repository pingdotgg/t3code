import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { LaunchEnv, type LaunchEnvShape } from "../Services/LaunchEnv.ts";
import { mergeResolvedLaunchEnv } from "../launchEnvUtils.ts";
import {
  LaunchEnvProjectLookupError,
  LaunchEnvThreadLookupError,
} from "../Services/LaunchEnvErrors.ts";

export const makeLaunchEnv = Effect.fn("makeLaunchEnv")(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const resolve: LaunchEnvShape["resolve"] = (input) =>
    Effect.succeed(
      mergeResolvedLaunchEnv({
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

  const resolveForThread: LaunchEnvShape["resolveForThread"] = Effect.fn(
    "LaunchEnv.resolveForThread",
  )(function* (input) {
    const threadOption = yield* projectionSnapshotQuery
      .getThreadShellById(ThreadId.make(input.threadId))
      .pipe(
        Effect.mapError(
          (cause) =>
            new LaunchEnvThreadLookupError({
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
            new LaunchEnvThreadLookupError({
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
          new LaunchEnvProjectLookupError({
            projectId: String(projectId),
            reason: "statFailed",
            cause,
          }),
      ),
    );

    const project = yield* Option.match(projectOption, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          new LaunchEnvProjectLookupError({
            projectId: String(projectId),
            reason: "notFound",
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

    return {
      projectId,
      worktreePath,
      env,
    } satisfies typeof input extends { projectId?: infer P }
      ? {
          projectId: P | typeof projectId;
          worktreePath?: string | null | undefined;
          env: Record<string, string>;
        }
      : never;
  });

  return {
    resolve,
    resolveForThread,
  } satisfies LaunchEnvShape;
});

export const LaunchEnvLive = Layer.effect(LaunchEnv, makeLaunchEnv());
