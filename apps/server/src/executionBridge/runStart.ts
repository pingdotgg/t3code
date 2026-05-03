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
  ProjectId,
  type TaskRuntimeMaterializeRequest,
  type TaskRuntimeMaterializeResponse,
  type TaskRuntimeLifecycleEvent,
  type TaskPullRequestEnsureRequest,
  type TaskPullRequestEnsureResponse,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";

import { GitManager } from "../git/GitManager.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveExecutionBridgeModelSelection } from "./requestDefaults.ts";
import { SandboxRuntime } from "../sandbox/Services/SandboxRuntime.ts";
import { GitVcsDriver, type GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";

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
    const modelSelection = resolveExecutionBridgeModelSelection(
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
    if (request.taskRuntime === true) {
      yield* runRegistry.trackAcceptedTaskRuntime({
        taskId: request.controlThreadId,
        workSessionId: request.executionRunId,
        threadId,
      });
    } else {
      yield* runRegistry.trackAcceptedRun({
        controlThreadId: request.controlThreadId,
        executionRunId: request.executionRunId,
        threadId,
      });
    }

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
    const sandboxRuntime = yield* SandboxRuntime;
    const runRegistry = yield* ExecutionBridgeRunRegistry;
    const result = yield* sandboxRuntime.materializeTaskRuntime(request);
    if (request.startCodingAgent) {
      yield* runRegistry.trackAcceptedTaskRuntime({
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        threadId: result.t3ThreadId,
      });
    }

    return result satisfies TaskRuntimeMaterializeResponse;
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

function parseGitHubPullRequestUrl(
  url: string | undefined,
): { owner: string; repo: string; number: number; url: string } | null {
  const match = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:\/[^\s]*)?/i.exec(
    url ?? "",
  );
  if (!match) {
    return null;
  }
  const [matchedUrl, owner, repo, numberText] = match;
  const number = Number(numberText);
  if (!owner || !repo || !Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { owner, repo, number, url: matchedUrl };
}

const readAheadCount = Effect.fn("executionBridge.readAheadCount")(function* (
  git: GitVcsDriverShape,
  cwd: string,
  baseRef: string,
) {
  const result = yield* git.execute({
    operation: "ExecutionBridge.ensureTaskPullRequest.readAheadCount",
    cwd,
    args: ["rev-list", "--count", `${baseRef}..HEAD`],
  });
  const count = Number(result.stdout.trim());
  return Number.isFinite(count) && count > 0 ? count : 0;
});

const hasCommittedChangesAgainstBase = Effect.fn("executionBridge.hasCommittedChangesAgainstBase")(
  function* (git: GitVcsDriverShape, cwd: string, baseBranch: string) {
    const localCount = yield* readAheadCount(git, cwd, baseBranch).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (localCount !== null) {
      return localCount > 0;
    }

    const remoteCount = yield* readAheadCount(git, cwd, `origin/${baseBranch}`).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    return remoteCount !== null && remoteCount > 0;
  },
);

const configureTaskPullRequestBaseBranch = Effect.fn(
  "executionBridge.configureTaskPullRequestBaseBranch",
)(function* (git: GitVcsDriverShape, cwd: string, branch: string, baseBranch: string) {
  yield* git
    .execute({
      operation: "ExecutionBridge.ensureTaskPullRequest.configureBaseBranch",
      cwd,
      args: ["config", `branch.${branch}.gh-merge-base`, baseBranch],
    })
    .pipe(Effect.catch(() => Effect.void));
});

export const ensureTaskPullRequest = (request: TaskPullRequestEnsureRequest) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;
    const gitManager = yield* GitManager;
    const checkedAt = new Date().toISOString();
    const details = yield* git.statusDetails(request.worktreePath);
    const branch = details.branch ?? request.branch;

    if (branch !== request.branch) {
      return {
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        status: "failed",
        checkedAt,
        summary: `Worktree is on branch ${branch}, expected ${request.branch}.`,
      } satisfies TaskPullRequestEnsureResponse;
    }

    if (!details.hasWorkingTreeChanges && !details.hasUpstream && details.aheadCount === 0) {
      return {
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        status: "waiting_for_changes",
        checkedAt,
        summary: "No task changes have been committed or staged yet.",
      } satisfies TaskPullRequestEnsureResponse;
    }

    const baseBranch = request.project.defaultBranch;
    yield* configureTaskPullRequestBaseBranch(git, request.worktreePath, branch, baseBranch);

    if (!details.hasWorkingTreeChanges) {
      const hasCommittedChanges = yield* hasCommittedChangesAgainstBase(
        git,
        request.worktreePath,
        baseBranch,
      );
      if (!hasCommittedChanges) {
        return {
          taskId: request.taskId,
          workSessionId: request.workSessionId,
          status: "waiting_for_changes",
          checkedAt,
          summary: "No task changes have been committed or staged yet.",
        } satisfies TaskPullRequestEnsureResponse;
      }
    }

    const action = details.hasWorkingTreeChanges ? "commit_push_pr" : "create_pr";
    const result = yield* gitManager.runStackedAction(
      {
        actionId: request.idempotencyKey,
        cwd: request.worktreePath,
        action,
        commitMessage: request.title,
        sourceControlRepository: `${request.project.githubOwner}/${request.project.githubRepo}`,
      },
      { draftPullRequest: true },
    );

    if (result.pr.status !== "created" && result.pr.status !== "opened_existing") {
      return {
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        status: "waiting_for_changes",
        checkedAt,
        summary: "No pull request was created because there are no publishable changes yet.",
      } satisfies TaskPullRequestEnsureResponse;
    }

    const parsed = parseGitHubPullRequestUrl(result.pr.url);
    const pullRequestNumber = result.pr.number ?? parsed?.number;
    if (!parsed || pullRequestNumber === undefined) {
      return {
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        status: "failed",
        checkedAt,
        summary: "GitHub pull request was created, but T3 could not parse its URL.",
      } satisfies TaskPullRequestEnsureResponse;
    }

    return {
      taskId: request.taskId,
      workSessionId: request.workSessionId,
      status: result.pr.status === "opened_existing" ? "existing" : "created",
      checkedAt,
      pullRequest: {
        owner: parsed.owner,
        repo: parsed.repo,
        number: pullRequestNumber,
        url: parsed.url,
        headBranch: result.pr.headBranch ?? request.branch,
        baseBranch: result.pr.baseBranch ?? request.project.defaultBranch,
        title: result.pr.title ?? request.title,
        draft: result.pr.status === "created",
      },
    } satisfies TaskPullRequestEnsureResponse;
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        taskId: request.taskId,
        workSessionId: request.workSessionId,
        status: "failed",
        checkedAt: new Date().toISOString(),
        summary: cause instanceof Error ? cause.message : "Failed to ensure a GitHub pull request.",
      } satisfies TaskPullRequestEnsureResponse),
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
