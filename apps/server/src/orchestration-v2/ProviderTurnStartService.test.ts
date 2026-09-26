import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  WorktreeMutationError,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
    thread: { id: threadId, branch: null, worktreePath: null },
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
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
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
  readonly openFailure?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
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
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "openFailure" in input
        ? Effect.sync(() => {
            if (input.interruptRunBeforeOpenFailure === true) {
              projection = {
                ...projection,
                runs: projection.runs.map((candidate) =>
                  candidate.id === runId
                    ? { ...candidate, status: "interrupted", completedAt: now }
                    : candidate,
                ),
              };
            }
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderSessionManager.ProviderSessionOpenError({
                  instanceId: newInstanceId,
                  providerSessionId,
                  cause: input.openFailure,
                }),
              ),
            ),
          )
        : Effect.die("A local command must not open a native session."),
  );
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
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    "writeFailure" in input
      ? Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: input.writeFailure,
          }),
        )
      : Effect.sync(() => {
          const current = projection.runs.find((candidate) => candidate.id === runId);
          const committed =
            current !== undefined &&
            current.activeAttemptId === activeAttemptId &&
            current.status === expectedStatus;
          if (committed) {
            for (const event of incoming) {
              expect(isDomainEvent(event)).toBe(true);
              events.push(event);
              projection = ProjectionStore.applyToProjection(projection, event);
            }
          }
          return { committed, storedEvents: [] };
        }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () =>
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getRuntimeRecoveryProjection: () =>
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );
  return {
    open,
    writeIfRunCurrent,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

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

/**
 * A worktree thread whose run is starting. `setGeneration` and `setRunStatus`
 * let one layer instance observe several starts, since the per-runtime
 * worktree generation lives in that instance.
 */
function makeWorktreeTurnStartFixture(input: {
  readonly revival: "revived" | "unchanged" | "failed";
  readonly revivalGate?: Effect.Effect<void>;
  /** Whether `get` reports the session as already open. */
  readonly liveSession?: boolean;
  /** Whether the adapter shares one session across provider threads. */
  readonly sharedSession?: boolean;
}) {
  const threadId = ThreadId.make(`thread_worktree_turn_start_${input.revival}`);
  const runId = RunId.make(`run_worktree_turn_start_${input.revival}`);
  const attemptId = RunAttemptId.make(`attempt_worktree_turn_start_${input.revival}`);
  const rootNodeId = NodeId.make(`node_worktree_turn_start_${input.revival}`);
  const providerThreadId = ProviderThreadId.make(
    `provider_thread_worktree_turn_start_${input.revival}`,
  );
  const providerSessionId = ProviderSessionId.make(
    `provider_session_worktree_turn_start_${input.revival}`,
  );
  const messageId = MessageId.make(`message_worktree_turn_start_${input.revival}`);
  const checkpointScopeId = CheckpointScopeId.make(
    `checkpoint_scope_worktree_turn_start_${input.revival}`,
  );
  const providerInstanceId = ProviderInstanceId.make(`provider_instance_${input.revival}`);
  const order: string[] = [];
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
      projectId: ProjectId.make(`project_worktree_turn_start_${input.revival}`),
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
  let generation = 0;
  const currentProjection = (): OrchestrationV2ThreadProjection => ({
    ...projection,
    runs: projection.runs.map((candidate) =>
      candidate.id === runId ? { ...candidate, status: runStatus } : candidate,
    ),
  });
  const session = {
    driver: "claudeAgent",
    instanceId: providerInstanceId,
    providerSessionId,
    providerSession: {
      id: providerSessionId,
      capabilities: {
        sessions: { supportsMultipleProviderThreadsPerSession: input.sharedSession === true },
      },
    },
    ensureThread: () => Effect.succeed(providerThread),
    resumeThread: () => Effect.succeed(providerThread),
    forkThread: () => Effect.succeed(providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const open = vi.fn(() =>
    Effect.sync(() => {
      order.push("open");
      return session;
    }),
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
          : Effect.sync(() => ({ revived: input.revival === "revived", generation })),
      ),
    ),
  );
  const startRootRun = vi.fn(() =>
    Effect.sync(() => {
      order.push("start-root-run");
    }),
  );
  const events: Array<OrchestrationV2DomainEvent> = [];
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: ({ events: written }) =>
            Effect.sync(() => {
              events.push(...written);
              return { committed: true, storedEvents: [] } as never;
            }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () =>
            Effect.sync(() => ({ ...currentProjection(), hasConversation: true })),
          getRuntimeRecoveryProjection: () => Effect.sync(currentProjection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open, close, get }),
        Layer.mock(ProviderAuthService)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp/t3-worktrees/feature-revival",
            }),
        }),
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({ reviveForThread }),
      ),
    ),
  );
  return {
    layer,
    order,
    events,
    open,
    close,
    startRootRun,
    start: Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
      service.start({ threadId, runId }),
    ),
    setRunStatus: (status: OrchestrationV2Run["status"]) => {
      runStatus = status;
    },
    setGeneration: (next: number) => {
      generation = next;
    },
  };
}

effectIt.effect("restarts a per-thread provider session after reviving its worktree", () =>
  Effect.gen(function* () {
    const fixture = makeWorktreeTurnStartFixture({ revival: "revived", liveSession: true });

    yield* fixture.start.pipe(Effect.provide(fixture.layer));

    expect(fixture.order).toEqual(["revive", "close", "open", "start-root-run"]);
  }),
);

effectIt.effect("keeps a shared provider session open after reviving a worktree", () =>
  Effect.gen(function* () {
    const fixture = makeWorktreeTurnStartFixture({
      revival: "revived",
      liveSession: true,
      sharedSession: true,
    });

    yield* fixture.start.pipe(Effect.provide(fixture.layer));

    expect(fixture.order).toEqual(["revive", "open", "start-root-run"]);
    expect(fixture.close).not.toHaveBeenCalled();
  }),
);

effectIt.effect("restarts a live session after another thread recreated its worktree", () =>
  Effect.gen(function* () {
    const fixture = makeWorktreeTurnStartFixture({ revival: "unchanged", liveSession: true });

    yield* Effect.gen(function* () {
      yield* fixture.start;
      fixture.setGeneration(1);
      yield* fixture.start;
    }).pipe(Effect.provide(fixture.layer));

    expect(fixture.order).toEqual([
      "revive",
      "open",
      "start-root-run",
      "revive",
      "close",
      "open",
      "start-root-run",
    ]);
  }),
);

effectIt.effect("fails the run with the reason when its worktree cannot be restored", () =>
  Effect.gen(function* () {
    const fixture = makeWorktreeTurnStartFixture({ revival: "failed", liveSession: true });

    yield* fixture.start.pipe(Effect.provide(fixture.layer));

    expect(fixture.order).toEqual(["revive"]);
    expect(fixture.events).toMatchObject([
      {
        type: "turn-item.updated",
        payload: {
          type: "error",
          title: "Worktree could not be restored",
          failure: {
            message: "Cannot recreate the worktree: branch 'feature/revival' no longer exists.",
          },
        },
      },
      { type: "run.updated", payload: { status: "failed" } },
      { type: "run-attempt.updated", payload: { status: "failed" } },
      { type: "node.updated", payload: { status: "failed" } },
    ]);
  }),
);

effectIt.effect("does not open a provider session for a run superseded during revival", () =>
  Effect.gen(function* () {
    const revivalStarted = yield* Deferred.make<void>();
    const releaseRevival = yield* Deferred.make<void>();
    const fixture = makeWorktreeTurnStartFixture({
      revival: "revived",
      liveSession: true,
      revivalGate: Deferred.succeed(revivalStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRevival)),
      ),
    });

    const start = yield* fixture.start.pipe(Effect.provide(fixture.layer), Effect.forkChild);
    yield* Deferred.await(revivalStarted);
    fixture.setRunStatus("cancelled");
    yield* Deferred.succeed(releaseRevival, undefined);
    yield* Fiber.join(start);

    expect(fixture.order).toEqual(["revive"]);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  }),
);
