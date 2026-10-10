import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import { checkpointCaptureEffectId, makeRunFinalizationFailedEvent } from "./RunFinalized.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";

const threadId = ThreadId.make("thread:run-finalized");
const runId = RunId.make("run:run-finalized");
const scopeId = CheckpointScopeId.make("scope:run-finalized");
const rootNodeId = NodeId.make("node:run-finalized-root");
const providerThreadId = ProviderThreadId.make("provider-thread:run-finalized");
const providerInstanceId = ProviderInstanceId.make("codex");
const checkpointId = CheckpointId.make("checkpoint:run-finalized");
const attemptId = RunAttemptId.make("attempt:run-finalized");

const maxAttempts = 2;
/** The worker's backoff after a capture's first failed attempt. */
const firstRetryDelay = "100 millis";
/** The worker's backoff after a capture's last attempt, when its failure record cannot commit. */
const lastRetryDelay = "200 millis";

/**
 * Real stores, outbox, worker, finalization and restart recovery. Checkpoint
 * capture and workspace refresh are stubs. `finalizationSink` can inject
 * faults into the event sink the finalization service writes through.
 */
const makeLayer = (
  capture: Effect.Effect<
    void,
    CheckpointCapture.CheckpointCaptureExecutionError,
    EventSink.EventSinkV2
  >,
  refresh: () => Effect.Effect<void, RunFinalization.RunFinalizationRefreshError> = () =>
    Effect.void,
  finalizationSink: (sink: EventSink.EventSinkV2Shape) => EventSink.EventSinkV2Shape = (sink) =>
    sink,
) => {
  const stores = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    EventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  );
  const eventSink = EventSink.layer.pipe(Layer.provide(stores));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const finalization = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        stores,
        Layer.effect(
          EventSink.EventSinkV2,
          EventSink.EventSinkV2.pipe(Effect.map(finalizationSink)),
        ).pipe(Layer.provide(eventSink)),
        Layer.effect(
          CheckpointCapture.CheckpointCaptureServiceV2,
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            return { execute: () => Effect.provideService(capture, EventSink.EventSinkV2, sink) };
          }),
        ).pipe(Layer.provide(eventSink)),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        finalization,
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
        Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
        Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
        Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        ServerSettings.layerTest(),
      ),
    ),
  );
  const worker = EffectWorker.layerWithOptions({
    workerId: "worker:run-finalized",
    maxAttempts,
  }).pipe(Layer.provide(Layer.merge(outbox, executor)));
  const recovery = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        stores,
        eventSink,
        outbox,
        worker,
        IdAllocator.layer,
        ServerSettings.layerTest(),
      ),
    ),
  );
  return Layer.mergeAll(stores, eventSink, outbox, finalization, worker, recovery);
};

const makeRun = (
  now: DateTime.Utc,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  providerThreadId,
  userMessageId: MessageId.make("message:run-finalized"),
  rootNodeId,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

let eventCounter = 0;
const runEvent = (
  type: "run.created" | "run.updated",
  run: OrchestrationV2Run,
  occurredAt: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:run-finalized-test:${(eventCounter += 1)}`),
  type,
  threadId,
  runId: run.id,
  providerInstanceId,
  occurredAt,
  payload: run,
});

const captureEffect = {
  id: checkpointCaptureEffectId(runId),
  commandId: CommandId.make(`command:effect:checkpoint.capture:${runId}`),
  threadId,
  request: { type: "checkpoint.capture" as const, runId, scopeId },
};

const seedThread = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* eventSink.write({
    events: [
      {
        id: EventId.make("event:run-finalized-test:thread"),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:run-finalized"),
          title: "Run finalized",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
      {
        id: EventId.make("event:run-finalized-test:scope"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        },
      },
      runEvent("run.created", makeRun(now, "running"), now),
    ],
  });
});

const storedEvents = Effect.gen(function* () {
  const eventStore = yield* EventStore.EventStoreV2;
  return Array.from(yield* eventStore.read({ threadId }).pipe(Stream.runCollect));
});

const finalizedEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
  events.flatMap((stored) => (stored.event.type === "run.finalized" ? [stored] : []));

/** Every finalization record for the thread, success or failure. */
const finalizationRecords = storedEvents.pipe(
  Effect.map((events) =>
    events.flatMap((stored) =>
      stored.event.type === "run.finalized" || stored.event.type === "run.finalization-failed"
        ? [{ type: stored.event.type, payload: stored.event.payload }]
        : [],
    ),
  ),
);

/** Runs every claimable effect on the real worker. */
const drainWorker = EffectWorker.OrchestrationEffectWorkerV2.pipe(
  Effect.flatMap((worker) => worker.drain()),
);

const captureStatus = EffectOutbox.EffectOutboxV2.pipe(
  Effect.flatMap((outbox) => outbox.get(captureEffect.id)),
  Effect.map(Option.map((effect) => effect.status)),
);

const runStatus = ProjectionStore.ProjectionStoreV2.pipe(
  Effect.flatMap((projections) =>
    projections.getCheckpointCaptureContext(threadId, { runId, scopeId }),
  ),
  Effect.map(({ run }) => run?.status),
);

/** The startup recovery a restarted server runs before its worker resumes. */
const restartServer = ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
  Effect.flatMap((recovery) => recovery.recover),
);

/** Stands in for CheckpointCaptureService: commits the checkpoint once, like the real one. */
const commitCapture = (status: "completed" | "interrupted" | "cancelled") =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.commitCommand({
      commandId: captureEffect.commandId,
      threadId,
      commandType: "checkpoint.capture",
      acceptedAt: now,
      effects: [],
      events: [
        runEvent("run.updated", makeRun(now, status, { checkpointId, completedAt: now }), now),
      ],
    });
  }).pipe(Effect.orDie);

const failCapture = Effect.fail(
  new CheckpointCapture.CheckpointCaptureExecutionError({
    threadId,
    runId,
    scopeId,
    cause: "simulated capture failure",
  }),
);

const failRefresh = () =>
  Effect.fail(
    new RunFinalization.RunFinalizationRefreshError({
      cwd: "/repo",
      cause: "simulated refresh failure",
    }),
  );

/** Ends the run waiting on its capture, as RunExecutionService does. */
const finishProviderTurn = (status: "waiting" | "interrupted" | "cancelled") =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.writeWithEffects({
      events: [
        runEvent(
          "run.updated",
          makeRun(now, status, status === "waiting" ? {} : { completedAt: now }),
          now,
        ),
      ],
      effects: [captureEffect],
    });
  });

it.effect("finalizes a completed run once, after its checkpoint and workspace refresh", () => {
  const refreshedAtSequence: Array<number> = [];
  let probe: Effect.Effect<void> = Effect.void;
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    assert.lengthOf(yield* finalizationRecords, 0);

    probe = eventSink.latestSequence({ threadId }).pipe(
      Effect.map((sequence) => {
        refreshedAtSequence.push(sequence);
      }),
      Effect.orDie,
    );
    yield* drainWorker;

    const events = yield* storedEvents;
    const finalized = finalizedEvents(events);
    assert.lengthOf(finalized, 1);
    const [stored] = finalized;
    assert.deepEqual(stored?.event.payload, { runId, outcome: "completed", checkpointId });
    assert.equal(stored?.event.id, EventId.make(`event:run-finalized:${runId}`));
    const completedAt = events.find(
      (event) => event.event.type === "run.updated" && event.event.payload.status === "completed",
    )?.sequence;
    assert.isDefined(completedAt);
    assert.deepEqual(refreshedAtSequence, [completedAt!]);
    assert.isTrue(stored!.sequence > completedAt!);
    assert.deepEqual(yield* captureStatus, Option.some("succeeded"));
  }).pipe(Effect.provide(makeLayer(commitCapture("completed"), () => probe)));
});

it.effect("recording the milestone leaves thread activity where the run left it", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    yield* drainWorker;

    const events = yield* storedEvents;
    const completed = events.find(
      (event) => event.event.type === "run.updated" && event.event.payload.status === "completed",
    );
    const [milestone] = finalizedEvents(events);
    assert.isDefined(completed);
    assert.isDefined(milestone);
    // The slow refresh put the milestone a minute after the run's last write.
    assert.isTrue(DateTime.isGreaterThan(milestone.event.occurredAt, completed.event.occurredAt));
    const shell = yield* projections.getThreadShell(threadId);
    assert.deepEqual(shell?.updatedAt, completed.event.occurredAt);
  }).pipe(
    Effect.provide(makeLayer(commitCapture("completed"), () => TestClock.adjust("60 seconds"))),
  ),
);

it.effect("a restart after finalizing but before settling records one milestone", () => {
  let captures = 0;
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const finalization = yield* RunFinalization.RunFinalizationService;
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    // A worker finalized, then its process died before settling the effect.
    yield* outbox.claimNext({ workerId: "worker:crashed", leaseDurationMs: 60_000 });
    yield* finalization.finalize({ threadId, runId, scopeId });
    assert.lengthOf(finalizedEvents(yield* storedEvents), 1);

    // Restart requeues the capture; the worker settles it without capturing again.
    const summary = yield* restartServer;
    assert.equal(summary.requeuedEffects, 1);
    yield* drainWorker;
    assert.deepEqual(yield* captureStatus, Option.some("succeeded"));
    assert.equal(captures, 1);
    // A later write of the finished run adds nothing either.
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        runEvent("run.updated", makeRun(now, "completed", { checkpointId, completedAt: now }), now),
      ],
    });
    assert.deepEqual(yield* finalizationRecords, [
      { type: "run.finalized", payload: { runId, outcome: "completed", checkpointId } },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer(
        Effect.suspend(() => {
          captures += 1;
          return commitCapture("completed");
        }),
      ),
    ),
  );
});

it.effect.each(["interrupted", "cancelled"] as const)(
  "a stopped run with a capture finalizes as %s after the capture",
  (status) =>
    Effect.gen(function* () {
      yield* seedThread;
      yield* finishProviderTurn(status);
      assert.lengthOf(yield* finalizationRecords, 0);
      yield* drainWorker;
      assert.deepEqual(yield* finalizationRecords, [
        { type: "run.finalized", payload: { runId, outcome: status, checkpointId } },
      ]);
    }).pipe(Effect.provide(makeLayer(commitCapture(status)))),
);

/** Ends a running attempt through the ownership guard, as RunExecutionService does. */
const finishGuardedTurn = (
  status: "interrupted" | "cancelled",
  guard: { readonly activeAttemptId: RunAttemptId; readonly expectedStatus: "running" | "waiting" },
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        runEvent("run.updated", makeRun(now, "running", { activeAttemptId: attemptId }), now),
      ],
    });
    return yield* eventSink.writeIfRunCurrent({
      threadId,
      runId,
      ...guard,
      events: [
        runEvent(
          "run.updated",
          makeRun(now, status, { activeAttemptId: attemptId, completedAt: now }),
          now,
        ),
      ],
      effects: [captureEffect],
    });
  });

it.effect.each(["interrupted", "cancelled"] as const)(
  "a guarded stop that queues a capture finalizes as %s after the capture",
  (status) =>
    Effect.gen(function* () {
      yield* seedThread;
      const result = yield* finishGuardedTurn(status, {
        activeAttemptId: attemptId,
        expectedStatus: "running",
      });
      assert.isTrue(result.committed);
      assert.lengthOf(yield* finalizationRecords, 0);
      yield* drainWorker;
      assert.deepEqual(yield* finalizationRecords, [
        { type: "run.finalized", payload: { runId, outcome: status, checkpointId } },
      ]);
    }).pipe(Effect.provide(makeLayer(commitCapture(status)))),
);

it.effect("a guarded stop that no longer owns the run commits and queues nothing", () =>
  Effect.gen(function* () {
    yield* seedThread;
    const result = yield* finishGuardedTurn("interrupted", {
      activeAttemptId: RunAttemptId.make("attempt:run-finalized-stale"),
      expectedStatus: "running",
    });
    assert.isFalse(result.committed);
    assert.deepEqual(yield* captureStatus, Option.none());
    assert.equal(yield* drainWorker, 0);
    assert.equal(yield* runStatus, "running");
    assert.lengthOf(yield* finalizationRecords, 0);
  }).pipe(Effect.provide(makeLayer(commitCapture("interrupted")))),
);

it.effect("a run that ends without a capture finalizes in its terminal commit", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* seedThread;
    const now = yield* DateTime.now;
    const failed = makeRun(now, "failed", { completedAt: now });
    const [terminal, milestone] = yield* eventSink.write({
      events: [runEvent("run.updated", failed, now)],
    });
    assert.equal(terminal?.event.type, "run.updated");
    assert.equal(milestone?.event.type, "run.finalized");
    assert.equal(milestone?.commandId, terminal?.commandId);
    // A repeated terminal write and a later update to the finished run add nothing.
    yield* eventSink.write({ events: [runEvent("run.updated", failed, now)] });
    yield* eventSink.write({
      events: [runEvent("run.updated", { ...failed, status: "cancelled" }, now)],
    });
    assert.deepEqual(
      finalizedEvents(yield* storedEvents).map((stored) => stored.event.payload),
      [{ runId, outcome: "failed", checkpointId: null }],
    );
  }).pipe(Effect.provide(makeLayer(Effect.void))),
);

it.effect("unfinished, discarded, and previously finished runs never finalize", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const finalization = yield* RunFinalization.RunFinalizationService;
    yield* seedThread;
    const now = yield* DateTime.now;
    // Waiting on a capture that never ran.
    yield* finishProviderTurn("waiting");
    assert.lengthOf(yield* finalizationRecords, 0);
    // Rolled back before the capture ran: discarded, and the capture skips it.
    yield* eventSink.write({
      events: [runEvent("run.updated", makeRun(now, "rolled_back", { completedAt: now }), now)],
    });
    yield* finalization.finalize({ threadId, runId, scopeId });
    assert.lengthOf(yield* finalizationRecords, 0);

    // A run that finished before this milestone existed has no event. A later
    // update to it must not invent one.
    const historical = makeRun(now, "completed", {
      id: RunId.make("run:run-finalized-historical"),
      ordinal: 2,
      completedAt: now,
    });
    yield* eventSink.write({ events: [runEvent("run.created", historical, now)] });
    yield* eventSink.write({ events: [runEvent("run.updated", historical, now)] });
    assert.lengthOf(yield* finalizationRecords, 0);
  }).pipe(Effect.provide(makeLayer(Effect.void))),
);

it.effect.each(["waiting", "interrupted"] as const)(
  "a capture that gives up after a %s turn records the failure, never run.finalized",
  (status) =>
    Effect.gen(function* () {
      yield* seedThread;
      yield* finishProviderTurn(status);
      // The first failure will be retried, so nothing is recorded yet.
      yield* drainWorker;
      assert.deepEqual(yield* captureStatus, Option.some("pending"));
      assert.lengthOf(yield* finalizationRecords, 0);

      yield* TestClock.adjust(firstRetryDelay);
      yield* drainWorker;
      assert.deepEqual(yield* captureStatus, Option.some("failed"));
      const failure = [
        {
          type: "run.finalization-failed" as const,
          payload: { runId, operation: "capture-checkpoint" as const },
        },
      ];
      assert.deepEqual(yield* finalizationRecords, failure);

      // A restart cancels a run still waiting on the failed capture. That is
      // not a finalization either.
      yield* restartServer;
      assert.equal(yield* runStatus, status === "waiting" ? "cancelled" : "interrupted");
      assert.deepEqual(yield* finalizationRecords, failure);
    }).pipe(Effect.provide(makeLayer(failCapture))),
);

it.effect("a refresh that gives up after the checkpoint commit records the failure", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    yield* drainWorker;
    yield* TestClock.adjust(firstRetryDelay);
    yield* drainWorker;

    assert.deepEqual(yield* captureStatus, Option.some("failed"));
    assert.equal(yield* runStatus, "completed");
    const failure = [
      {
        type: "run.finalization-failed" as const,
        payload: { runId, operation: "refresh-workspace" as const },
      },
    ];
    assert.deepEqual(yield* finalizationRecords, failure);
    // Neither a restart nor a later write of the completed run finalizes it.
    yield* restartServer;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        runEvent("run.updated", makeRun(now, "completed", { checkpointId, completedAt: now }), now),
      ],
    });
    assert.deepEqual(yield* finalizationRecords, failure);
  }).pipe(Effect.provide(makeLayer(commitCapture("completed"), failRefresh))),
);

it.effect("a refresh that fails once and then succeeds records only run.finalized", () => {
  let refreshes = 0;
  return Effect.gen(function* () {
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    yield* drainWorker;
    yield* TestClock.adjust(firstRetryDelay);
    yield* drainWorker;
    assert.equal(refreshes, 2);
    assert.deepEqual(yield* finalizationRecords, [
      { type: "run.finalized", payload: { runId, outcome: "completed", checkpointId } },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer(commitCapture("completed"), () =>
        Effect.suspend(() => ((refreshes += 1) === 1 ? failRefresh() : Effect.void)),
      ),
    ),
  );
});

it.effect(
  "a capture cancelled outside a command records the failure when restart ends the run",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* seedThread;
      yield* finishProviderTurn("waiting");
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["checkpoint.capture"],
        reason: "test",
      });
      assert.deepEqual(yield* captureStatus, Option.some("cancelled"));
      assert.lengthOf(yield* finalizationRecords, 0);
      yield* restartServer;
      assert.equal(yield* runStatus, "cancelled");
      assert.deepEqual(yield* finalizationRecords, [
        {
          type: "run.finalization-failed",
          payload: { runId, operation: "capture-checkpoint" },
        },
      ]);
    }).pipe(Effect.provide(makeLayer(Effect.void))),
);

it.effect("a command that cancels a capture records the failure in its commit", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* seedThread;
    yield* finishProviderTurn("interrupted");
    const now = yield* DateTime.now;
    const commandId = CommandId.make("command:run-finalized-test:cancel-capture");
    const { storedEvents, receipt } = yield* eventSink.commitCommand({
      commandId,
      threadId,
      commandType: "test.cancel-capture",
      acceptedAt: now,
      events: [runEvent("run.updated", makeRun(now, "interrupted", { completedAt: now }), now)],
      effects: [],
      cancelUnsettledEffects: { effectTypes: ["checkpoint.capture"], reason: "test" },
    });
    const failure = [
      {
        type: "run.finalization-failed" as const,
        payload: { runId, operation: "capture-checkpoint" as const },
      },
    ];
    assert.deepEqual(yield* captureStatus, Option.some("cancelled"));
    assert.deepEqual(yield* finalizationRecords, failure);
    const recorded = storedEvents.at(-1);
    assert.equal(recorded?.event.type, "run.finalization-failed");
    assert.equal(recorded?.commandId, commandId);
    assert.equal(receipt.resultSequence, recorded?.sequence);

    // Nothing runs the cancelled capture, and a restart adds nothing.
    assert.equal(yield* drainWorker, 0);
    yield* restartServer;
    assert.deepEqual(yield* finalizationRecords, failure);
  }).pipe(Effect.provide(makeLayer(Effect.die("a cancelled capture must not run")))),
);

const captureDefect = Effect.die("simulated unexpected checkpoint defect");
const refreshDefect = () => Effect.die("simulated unexpected refresh defect");

it.effect.each([
  {
    label: "a capture defect after a waiting turn",
    turn: "waiting" as const,
    capture: captureDefect,
    refresh: undefined,
    operation: "capture-checkpoint" as const,
    runAfterRestart: "cancelled",
  },
  {
    label: "a capture defect after an interrupted turn",
    turn: "interrupted" as const,
    capture: captureDefect,
    refresh: undefined,
    operation: "capture-checkpoint" as const,
    runAfterRestart: "interrupted",
  },
  {
    label: "a refresh defect after a completed run's checkpoint",
    turn: "waiting" as const,
    capture: commitCapture("completed"),
    refresh: refreshDefect,
    operation: "refresh-workspace" as const,
    runAfterRestart: "completed",
  },
  {
    label: "a refresh defect after an interrupted run's checkpoint",
    turn: "interrupted" as const,
    capture: commitCapture("interrupted"),
    refresh: refreshDefect,
    operation: "refresh-workspace" as const,
    runAfterRestart: "interrupted",
  },
])("$label records the failure when retries run out", (testCase) =>
  Effect.gen(function* () {
    yield* seedThread;
    yield* finishProviderTurn(testCase.turn);
    yield* drainWorker;
    assert.deepEqual(yield* captureStatus, Option.some("pending"));
    assert.lengthOf(yield* finalizationRecords, 0);

    yield* TestClock.adjust(firstRetryDelay);
    yield* drainWorker;
    assert.deepEqual(yield* captureStatus, Option.some("failed"));
    const failure = [
      {
        type: "run.finalization-failed" as const,
        payload: { runId, operation: testCase.operation },
      },
    ];
    assert.deepEqual(yield* finalizationRecords, failure);

    yield* restartServer;
    yield* drainWorker;
    assert.equal(yield* runStatus, testCase.runAfterRestart);
    assert.deepEqual(yield* captureStatus, Option.some("failed"));
    assert.deepEqual(yield* finalizationRecords, failure);
  }).pipe(Effect.provide(makeLayer(testCase.capture, testCase.refresh))),
);

it.effect("a failure record that cannot commit keeps the capture recoverable", () => {
  let faults = 1;
  let captures = 0;
  return Effect.gen(function* () {
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    yield* drainWorker;
    yield* TestClock.adjust(firstRetryDelay);
    // The last attempt fails and its failure record cannot commit.
    const exit = yield* Effect.exit(drainWorker);
    assert.isTrue(Exit.isFailure(exit));
    assert.equal(faults, 0);
    // The rolled-back commit neither failed the capture nor recorded anything.
    assert.deepEqual(yield* captureStatus, Option.some("pending"));
    assert.lengthOf(yield* finalizationRecords, 0);
    // The capture waits out the backoff instead of running again at once.
    yield* drainWorker;
    assert.equal(captures, 2);
    assert.deepEqual(yield* captureStatus, Option.some("pending"));

    // A restart keeps the work; the next attempt gives up and records it.
    yield* restartServer;
    yield* TestClock.adjust(lastRetryDelay);
    yield* drainWorker;
    assert.deepEqual(yield* captureStatus, Option.some("failed"));
    assert.deepEqual(yield* finalizationRecords, [
      {
        type: "run.finalization-failed",
        payload: { runId, operation: "capture-checkpoint" },
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer(
        Effect.suspend(() => {
          captures += 1;
          return failCapture;
        }),
        undefined,
        (sink) => ({
          ...sink,
          // Also append an event whose id is taken, so the commit fails after
          // the capture's terminal status was written inside it.
          failEffect: (input) =>
            Effect.suspend(() => {
              if (faults === 0) return sink.failEffect(input);
              faults -= 1;
              const at = input.events[0]!.occurredAt;
              return sink.failEffect({
                ...input,
                events: [
                  ...input.events,
                  {
                    ...runEvent("run.updated", makeRun(at, "waiting"), at),
                    id: EventId.make("event:run-finalized-test:thread"),
                  },
                ],
              });
            }),
        }),
      ),
    ),
  );
});

it.effect("a restart after a failure record but before settling never finalizes again", () => {
  let captures = 0;
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    // A worker recorded the failure, then its process died before settling
    // the capture (the state a non-atomic writer could leave).
    yield* outbox.claimNext({ workerId: "worker:crashed", leaseDurationMs: 60_000 });
    const context = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        projections.getCheckpointCaptureContext(threadId, { runId, scopeId }),
      ),
    );
    yield* eventSink.write({
      events: [
        makeRunFinalizationFailedEvent({
          run: context.run!,
          operation: "capture-checkpoint",
          occurredAt: yield* DateTime.now,
        }),
      ],
    });

    const summary = yield* restartServer;
    assert.equal(summary.requeuedEffects, 1);
    yield* drainWorker;
    assert.equal(captures, 0);
    assert.deepEqual(yield* captureStatus, Option.some("succeeded"));
    assert.deepEqual(yield* finalizationRecords, [
      {
        type: "run.finalization-failed",
        payload: { runId, operation: "capture-checkpoint" },
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer(
        Effect.suspend(() => {
          captures += 1;
          return commitCapture("completed");
        }),
      ),
    ),
  );
});

it.effect("an interrupted capture is replayed, never recorded as a failure", () => {
  let captures = 0;
  const started = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    yield* seedThread;
    yield* finishProviderTurn("waiting");
    // Interrupted on every attempt in a live worker: retried, not given up.
    yield* drainWorker;
    yield* TestClock.adjust(firstRetryDelay);
    yield* drainWorker;
    yield* TestClock.adjust("30 seconds");
    assert.deepEqual(yield* captureStatus, Option.some("pending"));
    assert.lengthOf(yield* finalizationRecords, 0);

    // A shutdown interrupts the worker mid-capture and leaves the claim running.
    const shuttingDown = yield* Effect.forkChild(drainWorker);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(shuttingDown);
    assert.deepEqual(yield* captureStatus, Option.some("running"));
    assert.lengthOf(yield* finalizationRecords, 0);

    // Restart replays it and the capture now succeeds.
    yield* restartServer;
    yield* drainWorker;
    assert.equal(captures, 4);
    assert.deepEqual(yield* finalizationRecords, [
      { type: "run.finalized", payload: { runId, outcome: "completed", checkpointId } },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer(
        Effect.suspend(() => {
          captures += 1;
          return captures <= 2
            ? Effect.interrupt
            : captures === 3
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : commitCapture("completed");
        }),
      ),
    ),
  );
});
