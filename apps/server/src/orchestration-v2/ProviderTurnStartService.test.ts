import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  WorktreeMutationError,
  ProviderDriverKind,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as WorktreeRevivalService from "../vcs/WorktreeRevivalService.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

function makeProviderTurnStartFixture(input: {
  readonly revival: "revived" | "unchanged" | "failed";
  readonly revivalGate?: Effect.Effect<void>;
  readonly cancelOnOpen?: boolean;
  /** Whether `get` reports the session as already open. */
  readonly liveSession?: boolean;
  /** Whether the adapter shares one session across provider threads. */
  readonly sharedSession?: boolean;
}) {
  const threadId = ThreadId.make(`thread_provider_turn_start_worktree_${input.revival}`);
  const runId = RunId.make(`run_provider_turn_start_worktree_${input.revival}`);
  const attemptId = RunAttemptId.make(`attempt_provider_turn_start_worktree_${input.revival}`);
  const rootNodeId = NodeId.make(`node_provider_turn_start_worktree_${input.revival}`);
  const providerThreadId = ProviderThreadId.make(
    `provider_thread_provider_turn_start_worktree_${input.revival}`,
  );
  const providerSessionId = ProviderSessionId.make(
    `provider_session_provider_turn_start_worktree_${input.revival}`,
  );
  const messageId = MessageId.make(`message_provider_turn_start_worktree_${input.revival}`);
  const checkpointScopeId = CheckpointScopeId.make(
    `checkpoint_scope_provider_turn_start_worktree_${input.revival}`,
  );
  const projectId = ProjectId.make(`project_provider_turn_start_worktree_${input.revival}`);
  const order: string[] = [];
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make(`provider_instance_${input.revival}`),
    nativeThreadRef: null,
    handoffIds: [],
    forkedFrom: null,
    appThreadId: threadId,
  };
  const projection = {
    thread: {
      id: threadId,
      projectId,
      branch: "feature/revival",
      worktreePath: "/tmp/t3-worktrees/feature-revival",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        providerInstanceId: providerThread.providerInstanceId,
        modelSelection: { instanceId: providerThread.providerInstanceId, model: "test-model" },
        ordinal: 1,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId, providerTurnId: null }],
    providerThreads: [providerThread],
    providerSessions: [{ id: providerSessionId }],
    providerTurns: [],
    messages: [
      {
        id: messageId,
        text: "continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let runStatus: OrchestrationV2Run["status"] = "starting";
  const currentProjection = (): OrchestrationV2ThreadProjection => ({
    ...projection,
    runs: projection.runs.map((candidate) =>
      candidate.id === runId ? { ...candidate, status: runStatus } : candidate,
    ),
  });
  const ensureThread = vi.fn(() => Effect.succeed(providerThread));
  const session = {
    driver: "codex",
    instanceId: providerThread.providerInstanceId,
    providerSessionId,
    providerSession: {
      id: providerSessionId,
      capabilities: {
        sessions: { supportsMultipleProviderThreadsPerSession: input.sharedSession === true },
      },
    },
    ensureThread,
    resumeThread: () => Effect.succeed(providerThread),
    forkThread: () => Effect.succeed(providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const open = vi.fn(() =>
    Effect.sync(() => {
      order.push("open");
      if (input.cancelOnOpen === true) runStatus = "cancelled";
    }).pipe(Effect.as(session)),
  );
  const close = vi.fn(() =>
    Effect.sync(() => {
      order.push("close");
    }),
  );
  const get = vi.fn(() =>
    Effect.succeed(
      input.liveSession === true
        ? Option.some(session)
        : Option.none<ProviderAdapterV2SessionRuntime>(),
    ),
  );
  const reviveForThread = vi.fn(() =>
    Effect.sync(() => {
      order.push("revive");
    }).pipe(
      Effect.andThen(input.revivalGate ?? Effect.void),
      Effect.andThen(
        input.revival === "failed"
          ? Effect.fail(
              new WorktreeMutationError({
                operation: "revive",
                stage: "missing_branch",
                branch: "feature/revival",
              }),
            )
          : Effect.succeed({
              revived: input.revival === "revived",
              generation: 0,
            }),
      ),
    ),
  );
  const worktreeLayer = Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({
    reviveForThread,
  });
  const getThreadProjection = vi.fn(() => Effect.sync(currentProjection));
  const startRootRun = vi.fn(() =>
    Effect.sync(() => {
      order.push("start-root-run");
    }),
  );
  const providerLayer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open, close, get }),
        Layer.mock(ProviderAuthService)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: projection.thread.worktreePath,
            }),
        }),
        worktreeLayer,
      ),
    ),
  );
  return {
    layer: providerLayer,
    order,
    open,
    close,
    reviveForThread,
    startRootRun,
    ensureThread,
    threadId,
    runId,
    setRunStatus: (status: OrchestrationV2Run["status"]) => {
      runStatus = status;
    },
  };
}

const makeSharedProviderSessionFixture = Effect.gen(function* () {
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_shared_generation",
  );
  const providerInstanceId = ProviderInstanceId.make(
    "provider_instance_provider_turn_start_shared_generation",
  );
  const projectId = ProjectId.make("project_provider_turn_start_shared_generation");
  const worktreePath = "/tmp/t3-worktrees/shared-generation";
  const branch = "feature/shared-generation";
  const makeProjection = (key: "first" | "second") => {
    const threadId = ThreadId.make(`thread_provider_turn_start_shared_generation_${key}`);
    const runId = RunId.make(`run_provider_turn_start_shared_generation_${key}`);
    const attemptId = RunAttemptId.make(`attempt_provider_turn_start_shared_generation_${key}`);
    const rootNodeId = NodeId.make(`node_provider_turn_start_shared_generation_${key}`);
    const providerThreadId = ProviderThreadId.make(
      `provider_thread_provider_turn_start_shared_generation_${key}`,
    );
    const messageId = MessageId.make(`message_provider_turn_start_shared_generation_${key}`);
    const checkpointScopeId = CheckpointScopeId.make(
      `checkpoint_scope_provider_turn_start_shared_generation_${key}`,
    );
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId,
      nativeThreadRef: null,
      handoffIds: [],
      forkedFrom: null,
      appThreadId: threadId,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        branch,
        worktreePath,
      },
      runs: [
        {
          id: runId,
          status: "starting",
          rootNodeId,
          activeAttemptId: attemptId,
          providerThreadId,
          userMessageId: messageId,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "test-model" },
          ordinal: 1,
        },
      ],
      nodes: [{ id: rootNodeId, checkpointScopeId }],
      attempts: [{ id: attemptId, providerTurnId: null }],
      providerThreads: [providerThread],
      providerSessions: [{ id: providerSessionId }],
      providerTurns: [],
      messages: [
        {
          id: messageId,
          text: `continue ${key}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      ],
      checkpointScopes: [{ id: checkpointScopeId }],
      contextHandoffs: [],
      contextTransfers: [],
      turnItems: [],
      subagents: [],
    } as unknown as OrchestrationV2ThreadProjection;
    return { key, threadId, runId, providerThread, projection };
  };
  const first = makeProjection("first");
  const second = makeProjection("second");
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [first.threadId, first.projection],
    [second.threadId, second.projection],
  ]);
  const providerThreads = new Map([
    [first.threadId, first.providerThread],
    [second.threadId, second.providerThread],
  ]);
  const keyByThreadId = new Map<ThreadId, "first" | "second">([
    [first.threadId, "first"],
    [second.threadId, "second"],
  ]);
  const order: string[] = [];
  const firstStartRootRunEntered = yield* Deferred.make<void>();
  const releaseFirstStartRootRun = yield* Deferred.make<void>();
  const secondRevivalCompleted = yield* Deferred.make<void>();
  const secondStartRootRunEntered = yield* Deferred.make<void>();

  const session = {
    driver: "codex",
    instanceId: providerInstanceId,
    providerSessionId,
    providerSession: {
      id: providerSessionId,
      capabilities: { sessions: { supportsMultipleProviderThreadsPerSession: false } },
    },
    ensureThread: (input: { readonly threadId: ThreadId }) =>
      Effect.sync(() => {
        const providerThread = providerThreads.get(input.threadId);
        if (providerThread === undefined) {
          throw new Error(`Missing provider thread for ${input.threadId}.`);
        }
        return providerThread;
      }),
    resumeThread: () => Effect.succeed(first.providerThread),
    forkThread: () => Effect.succeed(first.providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;
  let liveSession: ProviderAdapterV2SessionRuntime | undefined;
  const open = vi.fn((input: { readonly threadId: ThreadId }) =>
    Effect.sync(() => {
      order.push(`open:${keyByThreadId.get(input.threadId)}`);
      liveSession = session;
      return session;
    }),
  );
  const close = vi.fn(() =>
    Effect.sync(() => {
      order.push("close");
      liveSession = undefined;
    }),
  );
  const get = vi.fn(() => Effect.succeed(Option.fromNullishOr(liveSession)));
  const reviveForThread = vi.fn((input: { readonly threadId: ThreadId }) => {
    const key = keyByThreadId.get(input.threadId);
    return Effect.sync(() => {
      order.push(`revive:${key}`);
    }).pipe(
      Effect.andThen(
        key === "second" ? Deferred.succeed(secondRevivalCompleted, undefined) : Effect.void,
      ),
      Effect.as({ revived: false, generation: key === "second" ? 1 : 0 }),
    );
  });
  const startRootRun = vi.fn((input: { readonly appThread: { readonly id: ThreadId } }) => {
    const key = keyByThreadId.get(input.appThread.id);
    return Effect.sync(() => {
      order.push(`start-root-run:${key}`);
    }).pipe(
      Effect.andThen(
        key === "first"
          ? Deferred.succeed(firstStartRootRunEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstStartRootRun)),
              Effect.andThen(
                Effect.sync(() => {
                  order.push("start-root-run:first:completed");
                }),
              ),
            )
          : Deferred.succeed(secondStartRootRunEntered, undefined),
      ),
    );
  });
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: (threadId) =>
            Effect.sync(() => {
              const projection = projections.get(threadId);
              if (projection === undefined) {
                throw new Error(`Missing projection for ${threadId}.`);
              }
              return projection;
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open, close, get }),
        Layer.mock(ProviderAuthService)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: worktreePath,
            }),
        }),
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({ reviveForThread }),
      ),
    ),
  );

  return {
    first,
    second,
    layer,
    order,
    open,
    close,
    firstStartRootRunEntered,
    releaseFirstStartRootRun,
    secondRevivalCompleted,
    secondStartRootRunEntered,
  };
});

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: { id: threadId },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => {
            projectionReadCount += 1;
            return projectionReadCount === 1
              ? Effect.succeed(projection)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "simulated inherited-background projection failure",
                  }),
                );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService)({ tryHandlePromptCommand: () => Effect.succeed(false) }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      branch: null,
      worktreePath: null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  const open = vi.fn(() => Effect.die("A local command must not open a native session."));
  const startRootRun = vi.fn(() => Effect.die("A local command must not start a native turn."));
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: ({ events: incoming, activeAttemptId, expectedStatus }) =>
            Effect.sync(() => {
              const current = projection.runs.find((candidate) => candidate.id === runId);
              const committed =
                current?.activeAttemptId === activeAttemptId && current.status === expectedStatus;
              if (committed) {
                for (const event of incoming) {
                  expect(isDomainEvent(event)).toBe(true);
                  events.push(event);
                  projection = ProjectionStore.applyToProjection(projection, event);
                }
              }
              return { committed, storedEvents: [] };
            }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({}),
      ),
    ),
  );
  return {
    open,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

it("restarts the provider session after reviving a missing worktree", async () => {
  const fixture = makeProviderTurnStartFixture({ revival: "revived", liveSession: true });

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "close", "open", "start-root-run"]);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.open).toHaveBeenCalledOnce();
  expect(fixture.reviveForThread).toHaveBeenCalledOnce();
});

it("stops superseded restart work after restoring the shared provider session", async () => {
  const fixture = makeProviderTurnStartFixture({
    revival: "revived",
    cancelOnOpen: true,
    liveSession: true,
  });

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "close", "open"]);
  expect(fixture.ensureThread).not.toHaveBeenCalled();
  expect(fixture.startRootRun).not.toHaveBeenCalled();
});

it("keeps a shared provider session open after reviving a worktree", async () => {
  const fixture = makeProviderTurnStartFixture({
    revival: "revived",
    liveSession: true,
    sharedSession: true,
  });

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "open", "start-root-run"]);
  expect(fixture.close).not.toHaveBeenCalled();
});

it("starts the provider turn when worktree revival fails", async () => {
  const fixture = makeProviderTurnStartFixture({ revival: "failed", liveSession: true });

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "open", "start-root-run"]);
  expect(fixture.close).not.toHaveBeenCalled();
});

effectIt.effect("does not close a provider session after the starting attempt is superseded", () =>
  Effect.gen(function* () {
    const revivalStarted = yield* Deferred.make<void>();
    const releaseRevival = yield* Deferred.make<void>();
    const fixture = makeProviderTurnStartFixture({
      revival: "revived",
      revivalGate: Deferred.succeed(revivalStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRevival)),
      ),
    });

    const start = yield* ProviderTurnStart.ProviderTurnStartServiceV2.pipe(
      Effect.flatMap((service) =>
        service.start({
          threadId: fixture.threadId,
          runId: fixture.runId,
        }),
      ),
      Effect.provide(fixture.layer),
      Effect.forkChild,
    );
    yield* Deferred.await(revivalStarted);
    fixture.setRunStatus("cancelled");
    yield* Deferred.succeed(releaseRevival, undefined);
    yield* Fiber.join(start);

    expect(fixture.order).toEqual(["revive"]);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect(
  "serializes shared-session generation transitions through provider turn startup",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeSharedProviderSessionFixture;
      yield* Effect.gen(function* () {
        const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        const firstStart = yield* service
          .start({ threadId: fixture.first.threadId, runId: fixture.first.runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.firstStartRootRunEntered);

        const secondStart = yield* service
          .start({ threadId: fixture.second.threadId, runId: fixture.second.runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.secondRevivalCompleted);

        expect(fixture.order).toEqual([
          "revive:first",
          "open:first",
          "start-root-run:first",
          "revive:second",
        ]);
        expect(fixture.close).not.toHaveBeenCalled();
        expect(fixture.open).toHaveBeenCalledOnce();

        yield* Deferred.succeed(fixture.releaseFirstStartRootRun, undefined);
        yield* Deferred.await(fixture.secondStartRootRunEntered);
        yield* Fiber.join(firstStart);
        yield* Fiber.join(secondStart);

        expect(fixture.order).toEqual([
          "revive:first",
          "open:first",
          "start-root-run:first",
          "revive:second",
          "start-root-run:first:completed",
          "close",
          "open:second",
          "start-root-run:second",
        ]);
      }).pipe(Effect.provide(fixture.layer));

      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.open).toHaveBeenCalledTimes(2);
    }),
);
