import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  ProjectId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

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
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
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
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
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
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
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
  /** Opens the session, then fails loading its provider thread. */
  readonly ensureThreadFailure?: unknown;
  /**
   * Resumes a thread that has a native ref: resume fails, the fresh-thread
   * fallback succeeds, then reading history for its handoff fails.
   */
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  /** Loads the thread and starts the run, then fails every later state read. */
  readonly failReadsAfterRunning?: boolean;
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
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterEventStreamError({
          driver: providerThread.driver,
          providerSessionId,
          cause: "native thread is gone",
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
        ? Effect.succeed(resumeFallbackSession as never)
        : "ensureThreadFailure" in input
          ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
          : "openFailure" in input
            ? Effect.sync(() => {
                if (input.interruptRunBeforeOpenFailure === true) interruptRun();
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
            : input.failReadsAfterRunning === true
              ? Effect.succeed({
                  driver: providerThread.driver,
                  providerSession: {
                    id: providerSessionId,
                    driver: providerThread.driver,
                    providerInstanceId: newInstanceId,
                    status: "ready",
                    cwd: "/tmp/native-account-command",
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  ensureThread: () => Effect.succeed(providerThread),
                } as never)
              : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >(() =>
    input.failReadsAfterRunning === true
      ? Effect.void
      : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
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
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
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
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getThreadRecords: () => Effect.succeed(projection as never),
          getTurnStartHistory: () =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: input.historyReadFailureAfterFallback,
              }),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
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

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      // The provider succeeded; the failing stage is the projection read, so
      // the run is not failed as a provider error on the last attempt.
      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    // "false" would skip the provider turn or the terminal write and leave the
    // run active. A read failure must reach the caller instead.
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
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

// Runs the start path against the real event sink and projection store, so the
// failure write goes through the same commit guard production uses.
function makePersistedStartFailureHarness() {
  const now = DateTime.makeUnsafe("2026-10-06T12:00:00Z");
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex-start-failure");
  const threadId = ThreadId.make("thread-start-failure");
  const runId = RunId.make("run-start-failure");
  const attemptId = RunAttemptId.make("attempt-start-failure");
  const rootNodeId = NodeId.make("root-start-failure");
  const providerThreadId = ProviderThreadId.make("provider-thread-start-failure");
  const providerSessionId = ProviderSessionId.make("provider-session-start-failure");
  const providerTurnId = ProviderTurnId.make("provider-turn-start-failure");
  const checkpointScopeId = CheckpointScopeId.make("scope-start-failure");
  const messageId = MessageId.make("message-start-failure");
  const approvalNodeId = NodeId.make("node-approval-start-failure");
  const approvalRequestId = RuntimeRequestId.make("request-approval-start-failure");
  const approvalItemId = TurnItemId.make("item-approval-start-failure");
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-start-failure"),
    title: "Start failure",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: thread.modelSelection,
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
  const approvalRequest: OrchestrationV2RuntimeRequest = {
    id: approvalRequestId,
    nodeId: approvalNodeId,
    providerTurnId,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId },
    createdAt: now,
    resolvedAt: null,
  };
  const approvalNode: OrchestrationV2ExecutionNode = {
    id: approvalNodeId,
    threadId,
    runId,
    parentNodeId: rootNodeId,
    rootNodeId,
    kind: "approval_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    runtimeRequestId: approvalRequestId,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const approvalItem: OrchestrationV2TurnItem = {
    id: approvalItemId,
    threadId,
    runId,
    nodeId: approvalNodeId,
    providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    title: "Run npm test?",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "approval_request",
    requestId: approvalRequestId,
    requestKind: "command",
  };
  // The run as a restarted attempt inherits it: the earlier attempt left an
  // approval waiting under the run.
  const seedPayloads: ReadonlyArray<
    Pick<OrchestrationV2DomainEvent, "type" | "payload"> & { readonly runId?: RunId }
  > = [
    { type: "thread.created", payload: thread },
    {
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        createdBy: "user",
        creationSource: "web",
        text: "Continue",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    { type: "run.created", payload: run },
    {
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 2,
        rootNodeId,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "steering_restart",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    },
    {
      type: "checkpoint-scope.created",
      payload: {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/start-failure",
        createdAt: now,
      },
    },
    {
      type: "node.updated",
      payload: {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    { type: "node.updated", payload: approvalNode },
    { type: "runtime-request.updated", payload: approvalRequest },
    { type: "turn-item.updated", payload: approvalItem },
  ];
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(layerDatabase),
  );
  const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
  const layerPersistence = Layer.mergeAll(layerStores, layerSink, IdAllocator.layer);
  // `beforeFailureWrite` runs once the start has read its projection and
  // given up on the provider, right before the failure is committed.
  const run_ = (options: {
    /** Rows the run inherited besides the approval. */
    readonly seed?: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly beforeFailureWrite?: Effect.Effect<
      void,
      EventSink.EventSinkV2Error,
      EventSink.EventSinkV2
    >;
    readonly projectionStore?: (
      store: ProjectionStore.ProjectionStoreV2Shape,
      eventSink: EventSink.EventSinkV2Shape,
    ) => ProjectionStore.ProjectionStoreV2Shape;
  }) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      yield* eventSink.write({
        events: yield* Effect.forEach(seedPayloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
            } as OrchestrationV2DomainEvent;
          }),
        ),
      });
      if (options.seed !== undefined) yield* eventSink.write({ events: options.seed });
      const gatedSink = EventSink.EventSinkV2.of({
        ...eventSink,
        writeIfRunCurrent: (input) =>
          (options.beforeFailureWrite ?? Effect.void).pipe(
            Effect.provideService(EventSink.EventSinkV2, eventSink),
            Effect.orDie,
            Effect.andThen(eventSink.writeIfRunCurrent(input)),
          ),
      });
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2.pipe(
        Effect.provide(
          ProviderTurnStart.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EventSink.EventSinkV2, gatedSink),
                Layer.succeed(
                  ProjectionStore.ProjectionStoreV2,
                  options.projectionStore?.(store, eventSink) ?? store,
                ),
                IdAllocator.layer,
                Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
                FileSystem.layerNoop({}),
                Layer.mock(GitWorkflow.GitWorkflowService)({}),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                  open: () =>
                    Effect.fail(
                      new ProviderSessionManager.ProviderSessionOpenError({
                        instanceId,
                        providerSessionId,
                        cause: "replacement session failed to open",
                      }),
                    ),
                }),
                Layer.mock(ProviderAuthService.ProviderAuthService)({
                  tryHandlePromptCommand: () => Effect.succeed(false),
                }),
                Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                  startRootRun: () => Effect.die("a failed open must not start the run"),
                }),
                Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                  resolve: () => Effect.succeed({} as never),
                }),
              ),
            ),
          ),
        ),
      );
      yield* service.start({ threadId, runId });
      return yield* store.getThreadProjection(threadId);
    }).pipe(Effect.provide(Layer.fresh(layerPersistence)));
  return {
    now,
    driver,
    instanceId,
    threadId,
    runId,
    rootNodeId,
    providerThreadId,
    approvalRequest,
    approvalNode,
    approvalItem,
    run: run_,
  };
}

// The user accepts the approval the run inherited.
const acceptApproval = (
  harness: ReturnType<typeof makePersistedStartFailureHarness>,
  eventSink: EventSink.EventSinkV2Shape,
) =>
  eventSink.write({
    events: [
      {
        id: EventId.make("event-approval-accepted"),
        type: "runtime-request.updated",
        threadId: harness.threadId,
        nodeId: harness.approvalNode.id,
        occurredAt: harness.now,
        payload: {
          ...harness.approvalRequest,
          status: "resolved",
          decision: "accept",
          resolvedAt: harness.now,
        },
      },
      {
        id: EventId.make("event-approval-node-completed"),
        type: "node.updated",
        threadId: harness.threadId,
        nodeId: harness.approvalNode.id,
        occurredAt: harness.now,
        payload: { ...harness.approvalNode, status: "completed", completedAt: harness.now },
      },
      {
        id: EventId.make("event-approval-item-completed"),
        type: "turn-item.updated",
        threadId: harness.threadId,
        nodeId: harness.approvalNode.id,
        occurredAt: harness.now,
        payload: {
          ...harness.approvalItem,
          status: "completed",
          completedAt: harness.now,
          updatedAt: harness.now,
        },
      },
    ],
  });

const expectApprovalAccepted = (projection: OrchestrationV2ThreadProjection) => {
  expect(projection.runs.map((run) => run.status)).toEqual(["failed"]);
  expect(projection.runtimeRequests).toMatchObject([{ status: "resolved", decision: "accept" }]);
  const approvalNode = projection.nodes.find((node) => node.kind === "approval_request");
  const approvalItem = projection.turnItems.find((item) => item.type === "approval_request");
  expect(approvalNode?.status).toBe("completed");
  expect(approvalItem?.status).toBe("completed");
};

effectIt.effect("keeps an approval accepted while a failed start is written", () =>
  Effect.gen(function* () {
    const harness = makePersistedStartFailureHarness();
    const projection = yield* harness.run({
      // The user approves after the failure read the approval as pending.
      beforeFailureWrite: Effect.gen(function* () {
        yield* acceptApproval(harness, yield* EventSink.EventSinkV2);
      }),
    });

    expectApprovalAccepted(projection);
  }),
);

effectIt.effect("keeps an approval accepted while the failure reads what it inherited", () =>
  Effect.gen(function* () {
    const harness = makePersistedStartFailureHarness();
    let settling = false;
    let accepted = false;
    const projection = yield* harness.run({
      // The user approves while the failure's recovery read runs: it loaded
      // the approval's node and item as waiting, but the request had left the
      // pending-requests read, so no cancellation accompanies their settlement.
      projectionStore: (store, eventSink) => ({
        ...store,
        // Only the inherited-work read asks for subagent links.
        getThreadRecords: (threadId, fields, filter) =>
          Effect.sync(() => {
            if (fields.some((field) => field === "subagents")) settling = true;
          }).pipe(Effect.andThen(store.getThreadRecords(threadId, fields, filter))),
        getRuntimeRecoveryProjection: (threadId) =>
          store.getRuntimeRecoveryProjection(threadId).pipe(
            Effect.flatMap((recovery) =>
              !settling || accepted
                ? Effect.succeed(recovery)
                : Effect.sync(() => {
                    accepted = true;
                  }).pipe(
                    Effect.andThen(acceptApproval(harness, eventSink)),
                    Effect.orDie,
                    Effect.as({
                      ...recovery,
                      runtimeRequests: recovery.runtimeRequests.filter(
                        (request) => request.id !== harness.approvalRequest.id,
                      ),
                    }),
                  ),
            ),
          ),
      }),
    });

    expect(accepted).toBe(true);

    expectApprovalAccepted(projection);
  }),
);

effectIt.effect("fails the run when the work it inherited cannot be read", () =>
  Effect.gen(function* () {
    const harness = makePersistedStartFailureHarness();
    const projection = yield* harness.run({
      // The start's own reads succeed; only the inherited-work read fails.
      projectionStore: (store) => ({
        ...store,
        getThreadRecords: (threadId, fields, filter) =>
          fields.some((field) => field === "subagents")
            ? Effect.fail(
                new ProjectionStore.ProjectionStoreReadError({
                  threadId,
                  cause: "database unavailable",
                }),
              )
            : store.getThreadRecords(threadId, fields, filter),
      }),
    });

    expect(projection.runs.map((run) => run.status)).toEqual(["failed"]);
    expect(projection.attempts.map((attempt) => attempt.status)).toEqual(["failed"]);
    expect(projection.turnItems).toMatchObject([
      { type: "approval_request", status: "waiting" },
      { type: "error", title: "Provider session failed to open" },
    ]);
  }),
);

effectIt.effect("keeps a native subagent that completed while a failed start is written", () =>
  Effect.gen(function* () {
    const harness = makePersistedStartFailureHarness();
    const subagentNode: OrchestrationV2ExecutionNode = {
      ...harness.approvalNode,
      id: NodeId.make("node-subagent-start-failure"),
      kind: "subagent",
      status: "running",
      runtimeRequestId: null,
    };
    const subagent: OrchestrationV2Subagent = {
      id: subagentNode.id,
      threadId: harness.threadId,
      runId: harness.runId,
      parentNodeId: harness.rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: harness.driver,
      providerInstanceId: harness.instanceId,
      providerThreadId: harness.providerThreadId,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Explore the repo",
      title: "Explorer",
      model: null,
      status: "running",
      result: null,
      startedAt: harness.now,
      completedAt: null,
      updatedAt: harness.now,
    };
    const subagentItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item-subagent-start-failure"),
      threadId: harness.threadId,
      runId: harness.runId,
      nodeId: subagentNode.id,
      providerThreadId: harness.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "running",
      title: "Explorer",
      startedAt: harness.now,
      completedAt: null,
      updatedAt: harness.now,
      type: "subagent",
      subagentId: subagent.id,
      origin: "provider_native",
      driver: harness.driver,
      providerInstanceId: harness.instanceId,
      childThreadId: null,
      prompt: subagent.prompt,
      result: null,
    };
    const base = { threadId: harness.threadId, runId: harness.runId, occurredAt: harness.now };
    const subagentEvents = (
      label: string,
      update: { readonly status: "running" | "completed"; readonly result: string | null },
    ): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const completedAt = update.status === "completed" ? harness.now : null;
      return [
        {
          ...base,
          id: EventId.make(`event-subagent-node-${label}`),
          type: "node.updated",
          nodeId: subagentNode.id,
          payload: { ...subagentNode, status: update.status, completedAt },
        },
        {
          ...base,
          id: EventId.make(`event-subagent-${label}`),
          type: "subagent.updated",
          nodeId: subagent.id,
          payload: { ...subagent, ...update, completedAt },
        },
        {
          ...base,
          id: EventId.make(`event-subagent-item-${label}`),
          type: "turn-item.updated",
          nodeId: subagentNode.id,
          payload: { ...subagentItem, ...update, completedAt },
        },
      ];
    };
    const projection = yield* harness.run({
      seed: subagentEvents("running", { status: "running", result: null }),
      // The earlier attempt's session still reports on its native subagent;
      // it finishes after the failure read it as running.
      beforeFailureWrite: Effect.gen(function* () {
        yield* (yield* EventSink.EventSinkV2).write({
          events: subagentEvents("completed", { status: "completed", result: "Found it" }),
        });
      }),
    });

    expect(projection.runs.map((run) => run.status)).toEqual(["failed"]);
    expect(projection.subagents).toMatchObject([{ status: "completed", result: "Found it" }]);
    expect(projection.nodes.find((node) => node.id === subagentNode.id)?.status).toBe("completed");
    expect(projection.turnItems.find((item) => item.id === subagentItem.id)).toMatchObject({
      status: "completed",
      result: "Found it",
    });
  }),
);
