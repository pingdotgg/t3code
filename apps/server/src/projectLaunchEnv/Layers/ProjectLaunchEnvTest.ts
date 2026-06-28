import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProjectLaunchEnv,
  type ProjectLaunchEnvShape,
  type ResolvedProjectLaunchEnvForThread,
} from "../Services/ProjectLaunchEnv.ts";
import {
  ProjectLaunchEnvProjectLookupError,
  ProjectLaunchEnvThreadLookupError,
} from "../Services/ProjectLaunchEnvErrors.ts";
import { mergeResolvedProjectLaunchEnv } from "../projectLaunchEnvUtils.ts";

export type ProjectLaunchEnvTestFixtures = {
  readonly t3Home: string;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
};

const toProjectMap = (projects: ReadonlyArray<OrchestrationProjectShell> | undefined) =>
  new Map((projects ?? []).map((project) => [project.id, project] as const));

const toThreadMap = (threads: ReadonlyArray<OrchestrationThreadShell> | undefined) =>
  new Map((threads ?? []).map((thread) => [thread.id, thread] as const));

export const makeProjectLaunchEnvTestShape = (
  fixtures: ProjectLaunchEnvTestFixtures,
): ProjectLaunchEnvShape => {
  const resolve: ProjectLaunchEnvShape["resolve"] = (input) =>
    Effect.succeed(
      mergeResolvedProjectLaunchEnv({
        t3Home: fixtures.t3Home,
        ...(input.extraEnv !== undefined ? { extraEnv: input.extraEnv } : {}),
        context: {
          projectRoot: input.projectRoot,
          projectId: String(input.projectId),
          threadId: String(input.threadId),
          worktreePath: input.worktreePath ?? undefined,
        },
      }),
    );

  const projectsById = toProjectMap(fixtures.projects);
  const threadsById = toThreadMap(fixtures.threads);

  const resolveForThread: ProjectLaunchEnvShape["resolveForThread"] = Effect.fn(
    "ProjectLaunchEnv.resolveForThread",
  )(function* (input) {
    const threadOption = yield* Effect.succeed(
      Option.fromNullishOr(threadsById.get(ThreadId.make(input.threadId))),
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

    const project = yield* Effect.succeed(Option.fromNullishOr(projectsById.get(projectId))).pipe(
      Effect.flatMap((projectOption) =>
        Option.match(projectOption, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new ProjectLaunchEnvProjectLookupError({
                projectId: String(projectId),
                reason: "notFound",
              }),
            ),
        }),
      ),
    );

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
    } satisfies ResolvedProjectLaunchEnvForThread;
  });

  return {
    resolve,
    resolveForThread,
  };
};

export const projectLaunchEnvTestStub = (fixtures: {
  readonly t3Home: string;
  readonly projectId: ProjectId;
}): ProjectLaunchEnvShape => {
  const resolve: ProjectLaunchEnvShape["resolve"] = (input) =>
    Effect.succeed(
      mergeResolvedProjectLaunchEnv({
        t3Home: fixtures.t3Home,
        ...(input.extraEnv !== undefined ? { extraEnv: input.extraEnv } : {}),
        context: {
          projectRoot: input.projectRoot,
          projectId: String(input.projectId),
          threadId: input.threadId,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        },
      }),
    );

  return {
    resolve,
    resolveForThread: (resolveInput) =>
      Effect.succeed({
        projectId: fixtures.projectId,
        ...(resolveInput.worktreePath !== undefined
          ? { worktreePath: resolveInput.worktreePath }
          : {}),
        env: Object.fromEntries(
          Object.entries(resolveInput.extraEnv ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      } satisfies ResolvedProjectLaunchEnvForThread),
  };
};

export const ProjectLaunchEnvTestLayer = {
  stub: (input: { readonly t3Home: string; readonly projectId: ProjectId }) =>
    Layer.succeed(ProjectLaunchEnv, projectLaunchEnvTestStub(input)),

  withFixtures: (fixtures: ProjectLaunchEnvTestFixtures) =>
    Layer.succeed(ProjectLaunchEnv, makeProjectLaunchEnvTestShape(fixtures)),
};

/** Default CLI/unit-test layer: resolve-only stub with a fixed project id. */
export const defaultProjectLaunchEnvTestLayer = ProjectLaunchEnvTestLayer.stub({
  t3Home: "/tmp/t3-launch-env-test",
  projectId: ProjectId.make("project-1"),
});
