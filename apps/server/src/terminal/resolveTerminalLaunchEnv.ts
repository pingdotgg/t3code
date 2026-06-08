import {
  ProjectId,
  ThreadId,
  type TerminalAttachInput,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { LaunchEnv, type LaunchEnvShape } from "../launchEnv/Services/LaunchEnv.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalCwdError, TerminalSessionLookupError } from "./Services/Manager.ts";

export type TerminalAttachRuntimeInput = TerminalAttachInput & {
  readonly projectId: ProjectId;
};

export interface TerminalLaunchEnvResolver {
  readonly resolveOpenInput: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalOpenInput, TerminalCwdError>;
  readonly resolveRestartInput: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalRestartInput, TerminalCwdError>;
  readonly resolveAttachInput: (
    input: TerminalAttachInput,
  ) => Effect.Effect<TerminalAttachRuntimeInput, TerminalCwdError | TerminalSessionLookupError>;
}

export interface ResolveTerminalLaunchEnvInput {
  readonly projectId: ProjectId;
  readonly threadId: string;
  readonly worktreePath?: string | null;
  readonly extraEnv?: Record<string, string>;
}

export const resolveTerminalLaunchEnv = Effect.fn("resolveTerminalLaunchEnv")(function* (
  input: ResolveTerminalLaunchEnvInput,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const launchEnv = yield* LaunchEnv;
  const projectId = input.projectId;

  const projectOption = yield* projectionSnapshotQuery.getProjectShellById(projectId).pipe(
    Effect.mapError(
      (cause) =>
        new TerminalCwdError({
          cwd: projectId,
          reason: "statFailed",
          cause,
        }),
    ),
  );

  const project = yield* Option.match(projectOption, {
    onNone: () =>
      Effect.fail(
        new TerminalCwdError({
          cwd: projectId,
          reason: "notFound",
        }),
      ),
    onSome: Effect.succeed,
  });

  return yield* launchEnv.resolve({
    ...(input.extraEnv !== undefined ? { extraEnv: input.extraEnv } : {}),
    projectRoot: project.workspaceRoot,
    projectId: project.id,
    threadId: input.threadId,
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
  });
});

export const resolveTerminalOpenInput = Effect.fn("resolveTerminalOpenInput")(function* (
  input: TerminalOpenInput,
) {
  const env = yield* resolveTerminalLaunchEnv({
    projectId: input.projectId,
    threadId: input.threadId,
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.env !== undefined ? { extraEnv: input.env } : {}),
  });

  return {
    ...input,
    env,
  };
});

export const resolveTerminalRestartInput = Effect.fn("resolveTerminalRestartInput")(function* (
  input: TerminalRestartInput,
) {
  const env = yield* resolveTerminalLaunchEnv({
    projectId: input.projectId,
    threadId: input.threadId,
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.env !== undefined ? { extraEnv: input.env } : {}),
  });

  return {
    ...input,
    env,
  };
});

export const resolveTerminalAttachInput = Effect.fn("resolveTerminalAttachInput")(function* (
  input: TerminalAttachInput,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const threadOption = yield* projectionSnapshotQuery
    .getThreadShellById(ThreadId.make(input.threadId))
    .pipe(
      Effect.mapError(
        () =>
          new TerminalSessionLookupError({
            threadId: input.threadId,
            terminalId: input.terminalId,
          }),
      ),
    );

  const thread = yield* Option.match(threadOption, {
    onNone: () =>
      Effect.fail(
        new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        }),
      ),
    onSome: Effect.succeed,
  });

  const worktreePath = input.worktreePath !== undefined ? input.worktreePath : thread.worktreePath;

  const env = yield* resolveTerminalLaunchEnv({
    projectId: thread.projectId,
    threadId: input.threadId,
    worktreePath,
    ...(input.env !== undefined ? { extraEnv: input.env } : {}),
  });

  return {
    ...input,
    projectId: thread.projectId,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    env,
  } satisfies TerminalAttachRuntimeInput;
});

export type TerminalLaunchEnvResolverServices = LaunchEnv | ProjectionSnapshotQuery;

const provideTerminalLaunchEnvResolverServices = <A, E>(
  services: Context.Context<TerminalLaunchEnvResolverServices>,
  effect: Effect.Effect<A, E, TerminalLaunchEnvResolverServices>,
) => effect.pipe(Effect.provide(services));

export const bindTerminalLaunchEnvResolver = (
  launchEnv: LaunchEnvShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
): TerminalLaunchEnvResolver => {
  const services = Context.make(LaunchEnv, launchEnv).pipe(
    Context.add(ProjectionSnapshotQuery, projectionSnapshotQuery),
  );

  return {
    resolveOpenInput: (input) =>
      provideTerminalLaunchEnvResolverServices(services, resolveTerminalOpenInput(input)),
    resolveRestartInput: (input) =>
      provideTerminalLaunchEnvResolverServices(services, resolveTerminalRestartInput(input)),
    resolveAttachInput: (input) =>
      provideTerminalLaunchEnvResolverServices(services, resolveTerminalAttachInput(input)),
  };
};

export const terminalLaunchEnvResolverTest = (projectId: ProjectId): TerminalLaunchEnvResolver => ({
  resolveOpenInput: (input) => Effect.succeed(input),
  resolveRestartInput: (input) => Effect.succeed(input),
  resolveAttachInput: (input) =>
    Effect.succeed({
      ...input,
      projectId,
    }),
});
