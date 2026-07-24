import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

it.effect("drains durable effects before reporting recovery complete", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runOnce: Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.map((count) => count < 2),
            ),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.recover),
      Effect.provide(layer),
    );
    assert.deepEqual(summary, {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
      executedEffects: 2,
    });
  }),
);

it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
    },
  );
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_orphaned"),
        nodeId: NodeId.make("node_orphaned"),
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "old process" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    assert.equal(command?.events[0]?.type, "runtime-request.updated");
    if (command?.events[0]?.type === "runtime-request.updated") {
      assert.equal(command.events[0].payload.status, "expired");
      assert.equal(command.events[0].payload.responseCapability.type, "not_resumable");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("uses the same reconciliation path to cancel runtime requests during shutdown", () => {
  const threadId = ThreadId.make("thread_shutdown_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_shutdown"),
        nodeId: NodeId.make("node_shutdown"),
        status: "pending",
        responseCapability: { type: "live" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("shutdown");
    assert.equal(summary.closedRequests, 1);
    assert.equal(summary.retiredEffects, 1);
    const requestEvent = committedInput?.events[0];
    assert.equal(requestEvent?.type, "runtime-request.updated");
    if (requestEvent?.type === "runtime-request.updated") {
      assert.equal(requestEvent.payload.status, "cancelled");
      assert.equal(requestEvent.payload.responseCapability.type, "not_resumable");
      if (requestEvent.payload.responseCapability.type === "not_resumable") {
        assert.match(requestEvent.payload.responseCapability.reason, /shut down/);
      }
    }
  }).pipe(Effect.provide(layer));
});

it.effect("preserves a waiting run while its replay-safe checkpoint capture is unsettled", () => {
  const threadId = ThreadId.make("thread_waiting_checkpoint");
  const runId = RunId.make("run_waiting_checkpoint");
  const committed = vi.fn(() => Effect.succeed({ committed: true } as never));
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    runs: [{ id: runId, status: "waiting" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () =>
            Effect.succeed([
              {
                request: { type: "checkpoint.capture", runId },
                status: "running",
              },
            ] as never),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 0);
    assert.equal(summary.requeuedEffects, 1);
    assert.equal(committed.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("cancels a stale waiting run when no checkpoint capture can finish it", () => {
  const threadId = ThreadId.make("thread_stale_waiting");
  const runId = RunId.make("run_stale_waiting");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "waiting",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const runEvent = committedInput?.events.find((event) => event.type === "run.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("cancels accepted queued work instead of replaying it after restart", () => {
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "queued",
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "cancelled");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : 1, null);
    assert.equal(
      attemptEvent?.type === "run-attempt.updated" ? attemptEvent.payload.status : null,
      "cancelled",
    );
    assert.equal(nodeEvent?.type === "node.updated" ? nodeEvent.payload.status : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "cancels the complete in-flight subtree and stops its persisted session without reopening it",
  () => {
    const threadId = ThreadId.make("thread_recovery_cancel");
    const runId = RunId.make("run_recovery_cancel");
    const attemptId = RunAttemptId.make("attempt_recovery_cancel");
    const rootNodeId = NodeId.make("node_recovery_cancel");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_cancel");
    const providerTurnId = ProviderTurnId.make("provider_turn_recovery_cancel");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_cancel");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "active",
        },
      ],
      providerTurns: [
        {
          id: providerTurnId,
          runAttemptId: attemptId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
      runs: [
        {
          id: runId,
          status: "starting",
          providerThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          rootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: rootNodeId, runId, status: "running" }],
      subagents: [],
      messages: [{ id: MessageId.make("message_recovery_cancel"), runId, streaming: true }],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_recovery_cancel"),
          runId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [{ id: threadId }],
                archivedThreads: [],
              } as never),
            getThreadProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 2 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
        .recover;
      assert.equal(summary.terminalizedRuns, 1);
      assert.equal(summary.stoppedSessions, 1);
      assert.equal(summary.retiredEffects, 2);
      assert.deepEqual(committedInput?.cancelUnsettledEffects?.effectTypes, [
        "provider-turn.start",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "runtime-request.respond",
      ]);
      const events = committedInput?.events ?? [];
      assert.deepEqual(
        events.map((event) => [
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
        [
          ["run.updated", "cancelled"],
          ["run-attempt.updated", "cancelled"],
          ["node.updated", "cancelled"],
          ["provider-turn.updated", "cancelled"],
          ["message.updated", null],
          ["turn-item.updated", "cancelled"],
          ["provider-thread.updated", "idle"],
          ["provider-session.updated", "stopped"],
        ],
      );
      const messageEvent = events.find((event) => event.type === "message.updated");
      assert.isFalse(messageEvent?.type === "message.updated" && messageEvent.payload.streaming);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "clears persisted pendingBackgroundTasks and terminalizes stale background items on settled runs",
  () => {
    const threadId = ThreadId.make("thread_recovery_background");
    const settledRunId = RunId.make("run_recovery_background_settled");
    const activeRunId = RunId.make("run_recovery_background_active");
    const activeAttemptId = RunAttemptId.make("attempt_recovery_background_active");
    const activeRootNodeId = NodeId.make("node_recovery_background_active");
    const idleProviderThreadId = ProviderThreadId.make("provider_thread_recovery_background_idle");
    const activeProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_active",
    );
    const secondaryProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_secondary",
    );
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_background");
    const settledStaleItemId = TurnItemId.make("turn_item_recovery_background_stale");
    const activeRunItemId = TurnItemId.make("turn_item_recovery_background_active");
    const nullRunCommandItemId = TurnItemId.make("turn_item_recovery_background_null_run");
    const nullRunSubagentItemId = TurnItemId.make("turn_item_recovery_background_null_subagent");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    const secondaryInstanceId = ProviderInstanceId.make("claude-secondary");
    const subagentInstanceId = ProviderInstanceId.make("claude-subagent");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: idleProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          // Index-0 is intentionally a different instance so misattribution
          // to providerThreads[0] fails the assertions below.
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "bg-settled", description: "sleep 30" }],
        },
        {
          id: activeProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "active",
          pendingBackgroundTasks: [{ taskId: "bg-active", description: "npm test" }],
        },
        {
          id: secondaryProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: secondaryInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: settledRunId,
          status: "completed",
          providerInstanceId: claudeInstanceId,
        },
        {
          id: activeRunId,
          status: "running",
          providerInstanceId: claudeInstanceId,
        },
      ],
      attempts: [
        {
          id: activeAttemptId,
          runId: activeRunId,
          rootNodeId: activeRootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: activeRootNodeId, runId: activeRunId, status: "running" }],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: settledStaleItemId,
          runId: settledRunId,
          nodeId: null,
          providerThreadId: idleProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          id: activeRunItemId,
          runId: activeRunId,
          nodeId: activeRootNodeId,
          providerThreadId: activeProviderThreadId,
          type: "dynamic_tool",
          status: "running",
        },
        {
          // Missing run: must attribute via providerThreadId, not index 0.
          id: nullRunCommandItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          // Missing run with a real matching provider thread whose instance
          // differs from the subagent's own: own providerInstanceId must win.
          id: nullRunSubagentItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "subagent",
          status: "running",
          providerInstanceId: subagentInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [{ id: threadId }],
                archivedThreads: [],
              } as never),
            getThreadProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 1);
      const events = committedInput?.events ?? [];

      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      // Active-run item + settled-run stale + null-run command + null-run subagent.
      assert.equal(turnItemCancels.length, 4);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [activeRunItemId, nullRunCommandItemId, nullRunSubagentItemId, settledStaleItemId].sort(),
      );

      const cancelById = (id: TurnItemId) =>
        turnItemCancels.find(
          (event) => event.type === "turn-item.updated" && event.payload.id === id,
        );
      assert.equal(cancelById(nullRunCommandItemId)?.providerInstanceId, secondaryInstanceId);
      // Subagent own instance wins over the matching thread's secondary instance.
      assert.notEqual(subagentInstanceId, secondaryInstanceId);
      assert.equal(cancelById(nullRunSubagentItemId)?.providerInstanceId, subagentInstanceId);
      // Settled-run item still prefers the run's provider instance when present.
      assert.equal(cancelById(settledStaleItemId)?.providerInstanceId, claudeInstanceId);

      const providerThreadEvents = events.filter(
        (event) => event.type === "provider-thread.updated",
      );
      // Only threads with active status or nonempty rosters are rewritten.
      assert.equal(providerThreadEvents.length, 2);
      for (const event of providerThreadEvents) {
        if (event.type !== "provider-thread.updated") continue;
        assert.deepEqual(event.payload.pendingBackgroundTasks ?? [], []);
      }
      const idleThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === idleProviderThreadId,
      );
      assert.equal(
        idleThreadEvent?.type === "provider-thread.updated" ? idleThreadEvent.payload.status : null,
        "idle",
      );
      const activeThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === activeProviderThreadId,
      );
      assert.equal(
        activeThreadEvent?.type === "provider-thread.updated"
          ? activeThreadEvent.payload.status
          : null,
        "idle",
      );
    }).pipe(Effect.provide(layer));
  },
);
