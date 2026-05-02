import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ExecutionRunCreateRequest,
  type ExecutionRunCreateResponse,
  type ExecutionRunContinueRequest,
  type ExecutionRunContinueResponse,
  type ExecutionRunInterruptRequest,
  type ExecutionRunInterruptResponse,
  type ExecutionRunLifecycleEvent,
  MessageId,
  type ModelSelection,
  ProjectId,
  type TaskRuntimeMaterializeRequest,
  type TaskRuntimeMaterializeResponse,
  type TaskRuntimeLifecycleEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";

import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

export type ExecutionLifecycleCheckpoint = "started" | "completed" | "failed" | "interrupted";

export interface TrackedExecutionRun {
  readonly kind: "execution" | "task";
  readonly controlThreadId: string;
  readonly executionRunId: string;
  readonly taskId: string | null;
  readonly workSessionId: string | null;
  readonly threadId: ThreadId;
  readonly startedEventId: string | null;
  readonly completedEventId: string | null;
  readonly failedEventId: string | null;
  readonly interruptedEventId: string | null;
  readonly lastTurnId: TurnId | null;
}

interface ExecutionBridgeRunRegistryShape {
  readonly trackAcceptedRun: (
    input: Pick<TrackedExecutionRun, "controlThreadId" | "executionRunId" | "threadId">,
  ) => Effect.Effect<void, never, never>;
  readonly trackAcceptedTaskRuntime: (
    input: Pick<TrackedExecutionRun, "taskId" | "workSessionId" | "threadId">,
  ) => Effect.Effect<void, never, never>;
  readonly getTrackedRun: (
    threadId: ThreadId,
  ) => Effect.Effect<TrackedExecutionRun | null, never, never>;
  readonly markLifecycleDelivered: (
    input: Pick<TrackedExecutionRun, "threadId"> & {
      readonly type: ExecutionLifecycleCheckpoint;
      readonly eventId: string;
      readonly turnId?: TurnId;
    },
  ) => Effect.Effect<void, never, never>;
}

export class ExecutionBridgeRunRegistry extends Context.Service<
  ExecutionBridgeRunRegistry,
  ExecutionBridgeRunRegistryShape
>()("t3/executionBridge/ExecutionBridgeRunRegistry") {}

function deriveProjectTitle(workspaceRoot: string) {
  const segments = workspaceRoot.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? "project";
}

function deriveThreadTitle(input: ExecutionRunCreateRequest) {
  const trimmedTitle = input.title?.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }
  return `Run ${input.controlThreadId}`;
}

function buildTaskBranchName(input: { readonly taskId: string; readonly title: string }) {
  const titleFragment = input.title
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 48)
    .replace(/[./_-]+$/g, "");
  const idFragment = input.taskId.replace(/[^a-zA-Z0-9]+/g, "-").slice(-12) || "task";
  return `task/${titleFragment || "update"}-${idFragment}`;
}

function resolveModelSelection(
  request: ExecutionRunCreateRequest,
  existingProjectDefault: ModelSelection | null,
) {
  return (
    request.modelSelection ?? existingProjectDefault ?? getAutoBootstrapDefaultModelSelection()
  );
}

const makeExecutionBridgeRunRegistry = Effect.gen(function* () {
  const state = yield* Ref.make(new Map<string, TrackedExecutionRun>());

  const trackAcceptedRun: ExecutionBridgeRunRegistryShape["trackAcceptedRun"] = (input) =>
    Ref.update(state, (current) => {
      const next = new Map(current);
      next.set(String(input.threadId), {
        controlThreadId: input.controlThreadId,
        executionRunId: input.executionRunId,
        kind: "execution",
        taskId: null,
        workSessionId: null,
        threadId: input.threadId,
        startedEventId: null,
        completedEventId: null,
        failedEventId: null,
        interruptedEventId: null,
        lastTurnId: null,
      });
      return next;
    });

  const trackAcceptedTaskRuntime: ExecutionBridgeRunRegistryShape["trackAcceptedTaskRuntime"] = (
    input,
  ) =>
    Ref.update(state, (current) => {
      const next = new Map(current);
      next.set(String(input.threadId), {
        controlThreadId: input.taskId ?? "",
        executionRunId: input.workSessionId ?? "",
        kind: "task",
        taskId: input.taskId,
        workSessionId: input.workSessionId,
        threadId: input.threadId,
        startedEventId: null,
        completedEventId: null,
        failedEventId: null,
        interruptedEventId: null,
        lastTurnId: null,
      });
      return next;
    });

  const getTrackedRun: ExecutionBridgeRunRegistryShape["getTrackedRun"] = (threadId) =>
    Ref.get(state).pipe(Effect.map((current) => current.get(String(threadId)) ?? null));

  const markLifecycleDelivered: ExecutionBridgeRunRegistryShape["markLifecycleDelivered"] = (
    input,
  ) =>
    Ref.update(state, (current) => {
      const tracked = current.get(String(input.threadId));
      if (!tracked) {
        return current;
      }

      const next = new Map(current);
      next.set(String(input.threadId), {
        ...tracked,
        startedEventId: input.type === "started" ? input.eventId : tracked.startedEventId,
        completedEventId: input.type === "completed" ? input.eventId : tracked.completedEventId,
        failedEventId: input.type === "failed" ? input.eventId : tracked.failedEventId,
        interruptedEventId:
          input.type === "interrupted" ? input.eventId : tracked.interruptedEventId,
        lastTurnId: input.turnId ?? tracked.lastTurnId,
      });
      return next;
    });

  return {
    trackAcceptedRun,
    trackAcceptedTaskRuntime,
    getTrackedRun,
    markLifecycleDelivered,
  } satisfies ExecutionBridgeRunRegistryShape;
});

export const ExecutionBridgeRunRegistryLive = Layer.effect(
  ExecutionBridgeRunRegistry,
  makeExecutionBridgeRunRegistry,
);

export class ExecutionBridgeRunStartError extends Schema.TaggedErrorClass<ExecutionBridgeRunStartError>()(
  "ExecutionBridgeRunStartError",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export const startExecutionRun = (request: ExecutionRunCreateRequest) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const runRegistry = yield* ExecutionBridgeRunRegistry;
    const now = new Date().toISOString();

    const existingProject = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
      request.workspaceRoot,
    );

    const projectId = Option.isSome(existingProject)
      ? existingProject.value.id
      : ProjectId.make(crypto.randomUUID());
    const modelSelection = resolveModelSelection(
      request,
      Option.isSome(existingProject) ? existingProject.value.defaultModelSelection : null,
    );

    if (Option.isNone(existingProject)) {
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`execution-bridge:project:create:${request.executionRunId}`),
        projectId,
        title: deriveProjectTitle(request.workspaceRoot),
        workspaceRoot: request.workspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
    }

    const threadId = ThreadId.make(crypto.randomUUID());
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`execution-bridge:thread:create:${request.executionRunId}`),
      threadId,
      projectId,
      title: deriveThreadTitle(request),
      modelSelection,
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: now,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`execution-bridge:turn:start:${request.executionRunId}`),
      threadId,
      message: {
        messageId: MessageId.make(`execution-run:${request.executionRunId}`),
        role: "user",
        text: request.initialPrompt,
        attachments: [],
      },
      modelSelection,
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    });

    // We track the accepted run by thread id so the lifecycle watcher can map later
    // session updates back to the originating orchestrator execution run.
    yield* runRegistry.trackAcceptedRun({
      controlThreadId: request.controlThreadId,
      executionRunId: request.executionRunId,
      threadId,
    });

    return {
      controlThreadId: request.controlThreadId,
      executionRunId: request.executionRunId,
      t3ThreadId: threadId,
      acceptedAt: now,
    } satisfies ExecutionRunCreateResponse;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionBridgeRunStartError({
          message:
            cause instanceof Error ? cause.message : "Failed to dispatch execution bridge run.",
          status: 400,
        }),
    ),
  );

export const continueExecutionRun = (request: ExecutionRunContinueRequest) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const runRegistry = yield* ExecutionBridgeRunRegistry;
    const now = new Date().toISOString();

    const threadId = request.t3ThreadId;

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(
        `execution-bridge:turn:continue:${request.executionRunId}:${Date.now()}`,
      ),
      threadId,
      message: {
        messageId: MessageId.make(`execution-run:continue:${request.executionRunId}:${Date.now()}`),
        role: "user",
        text: request.prompt,
        attachments: [],
      },
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    });

    const existingTracked = yield* runRegistry.getTrackedRun(threadId);
    if (existingTracked === null || existingTracked.executionRunId !== request.executionRunId) {
      yield* runRegistry.trackAcceptedRun({
        controlThreadId: request.controlThreadId,
        executionRunId: request.executionRunId,
        threadId,
      });
    }

    return {
      executionRunId: request.executionRunId,
      t3ThreadId: threadId,
      acceptedAt: now,
    } satisfies ExecutionRunContinueResponse;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionBridgeRunStartError({
          message:
            cause instanceof Error
              ? cause.message
              : "Failed to dispatch execution bridge continue.",
          status: 400,
        }),
    ),
  );

export const interruptExecutionRun = (request: ExecutionRunInterruptRequest) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const now = new Date().toISOString();

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(
        `execution-bridge:turn:interrupt:${request.executionRunId}:${Date.now()}`,
      ),
      threadId: request.t3ThreadId,
      createdAt: now,
    });

    return {
      executionRunId: request.executionRunId,
      t3ThreadId: request.t3ThreadId,
      acceptedAt: now,
    } satisfies ExecutionRunInterruptResponse;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionBridgeRunStartError({
          message:
            cause instanceof Error
              ? cause.message
              : "Failed to dispatch execution bridge interrupt.",
          status: 400,
        }),
    ),
  );

export const materializeTaskRuntime = (request: TaskRuntimeMaterializeRequest) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const runRegistry = yield* ExecutionBridgeRunRegistry;
    const git = yield* GitCore;
    const now = new Date().toISOString();

    const existingProject = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
      request.project.workspaceRoot,
    );

    const projectId = Option.isSome(existingProject)
      ? existingProject.value.id
      : ProjectId.make(crypto.randomUUID());
    const modelSelection = resolveModelSelection(
      {
        initialPrompt: request.initialPrompt,
        workspaceRoot: request.project.workspaceRoot,
        title: request.title,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        controlThreadId: request.taskId,
        executionRunId: request.workSessionId,
        ...(request.modelSelection !== undefined ? { modelSelection: request.modelSelection } : {}),
      },
      Option.isSome(existingProject) ? existingProject.value.defaultModelSelection : null,
    );

    if (Option.isNone(existingProject)) {
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`task-runtime:project:create:${request.taskId}`),
        projectId,
        title: request.project.repoName,
        workspaceRoot: request.project.workspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
    }

    const branch = buildTaskBranchName({ taskId: request.taskId, title: request.title });
    const worktree = yield* git.createWorktree({
      cwd: request.project.workspaceRoot,
      branch: request.project.defaultBranch,
      newBranch: branch,
      path: null,
    });

    const threadId = ThreadId.make(crypto.randomUUID());
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`task-runtime:thread:create:${request.workSessionId}`),
      threadId,
      projectId,
      title: request.title,
      modelSelection,
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode,
      branch: worktree.worktree.branch,
      worktreePath: worktree.worktree.path,
      createdAt: now,
    });

    if (request.startCodingAgent) {
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`task-runtime:turn:start:${request.workSessionId}`),
        threadId,
        message: {
          messageId: MessageId.make(`task-runtime:${request.workSessionId}`),
          role: "user",
          text: request.initialPrompt,
          attachments: [],
        },
        modelSelection,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        createdAt: now,
      });

      yield* runRegistry.trackAcceptedTaskRuntime({
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        threadId,
      });
    }

    return {
      taskId: request.taskId,
      workSessionId: request.workSessionId,
      t3ProjectId: projectId,
      t3ThreadId: threadId,
      branch: worktree.worktree.branch,
      worktreePath: worktree.worktree.path,
      acceptedAt: now,
    } satisfies TaskRuntimeMaterializeResponse;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutionBridgeRunStartError({
          message:
            cause instanceof Error ? cause.message : "Failed to materialize Task runtime in T3.",
          status: 400,
        }),
    ),
  );

export function buildLifecycleEvent(input: {
  readonly trackedRun: TrackedExecutionRun;
  readonly type: ExecutionLifecycleCheckpoint;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly t3TurnId?: TurnId;
  readonly failureSummary?: string;
}): ExecutionRunLifecycleEvent {
  return {
    eventId: input.eventId,
    controlThreadId: input.trackedRun.controlThreadId,
    executionRunId: input.trackedRun.executionRunId,
    type: input.type,
    occurredAt: input.occurredAt,
    t3ThreadId: input.trackedRun.threadId,
    ...((input.t3TurnId ?? input.trackedRun.lastTurnId)
      ? { t3TurnId: input.t3TurnId ?? input.trackedRun.lastTurnId! }
      : {}),
    ...(input.failureSummary ? { failureSummary: input.failureSummary } : {}),
  };
}

export function buildTaskRuntimeLifecycleEvent(input: {
  readonly trackedRun: TrackedExecutionRun;
  readonly type: ExecutionLifecycleCheckpoint;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly t3TurnId?: TurnId;
  readonly failureSummary?: string;
}): TaskRuntimeLifecycleEvent {
  if (input.trackedRun.taskId === null || input.trackedRun.workSessionId === null) {
    throw new Error("Cannot build Task runtime lifecycle event for non-Task tracked run.");
  }

  return {
    eventId: input.eventId,
    taskId: input.trackedRun.taskId,
    workSessionId: input.trackedRun.workSessionId,
    type: input.type,
    occurredAt: input.occurredAt,
    t3ThreadId: input.trackedRun.threadId,
    ...((input.t3TurnId ?? input.trackedRun.lastTurnId)
      ? { t3TurnId: input.t3TurnId ?? input.trackedRun.lastTurnId! }
      : {}),
    ...(input.failureSummary ? { failureSummary: input.failureSummary } : {}),
  };
}
