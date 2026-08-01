import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@piku/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import {
  EventSinkV2,
  isEventSinkIllegalTransitionError,
  layer as eventSinkLayer,
} from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { RunJanitorV2, layer as runJanitorLayer } from "./RunJanitorService.ts";
import {
  RunLeaseServiceV2,
  RunLeaseTimingsRef,
  layer as runLeaseServiceLayer,
} from "./RunLeaseService.ts";

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const effectOutboxProvided = effectOutboxLayer.pipe(Layer.provide(databaseLayer));
const timingsLayer = Layer.succeed(RunLeaseTimingsRef, {
  ttlMs: 30_000,
  renewIntervalMs: 10_000,
  janitorIntervalMs: 15_000,
  graceMs: 60_000,
});
const runLeaseProvided = runLeaseServiceLayer.pipe(
  Layer.provide(Layer.merge(databaseLayer, timingsLayer)),
);
const recoveryProvided = ProviderRuntimeRecovery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      storesProvided,
      eventSinkProvided,
      effectOutboxProvided,
      idAllocatorLayer,
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
    ),
  ),
);
const runJanitorProvided = runJanitorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(databaseLayer, effectOutboxProvided, recoveryProvided, timingsLayer),
  ),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  effectOutboxProvided,
  runLeaseProvided,
  runJanitorProvided,
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
}): OrchestrationV2Run {
  return {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

let eventCounter = 0;
function threadCreatedEvent(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  eventCounter += 1;
  return {
    id: EventId.make(`event:lifecycle:${input.thread.id}:${eventCounter}`),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

function runEvent(input: {
  readonly type: "run.created" | "run.updated";
  readonly run: OrchestrationV2Run;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  eventCounter += 1;
  return {
    id: EventId.make(`event:lifecycle:${input.run.id}:${eventCounter}`),
    type: input.type,
    threadId: input.run.threadId,
    runId: input.run.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.run,
  };
}

it.layer(TestLayer)("orchestration V2 run lifecycle guarantees", (it) => {
  it.effect("rejects commits that resurrect a terminal run", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:lifecycle:gate");
      const runId = RunId.make("run:lifecycle:gate");
      const run = makeRun({ threadId, runId, ordinal: 1, status: "running", now });

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ thread: makeThread(threadId, now), now }),
          runEvent({ type: "run.created", run, now }),
          runEvent({ type: "run.updated", run: { ...run, status: "completed" }, now }),
        ],
      });
      const sequenceBefore = yield* eventStore.latestSequence();

      const rejected = yield* Effect.flip(
        eventSink.write({
          events: [runEvent({ type: "run.updated", run: { ...run, status: "running" }, now })],
        }),
      );
      assert.isTrue(isEventSinkIllegalTransitionError(rejected.cause));

      const sequenceAfter = yield* eventStore.latestSequence();
      assert.equal(sequenceAfter, sequenceBefore);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(
        projection.runs.find((candidate) => candidate.id === runId)?.status,
        "completed",
      );
    }),
  );

  it.effect("rejects a batch whose folded transitions resurrect an entity", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:lifecycle:gate-batch");
      const runId = RunId.make("run:lifecycle:gate-batch");
      const run = makeRun({ threadId, runId, ordinal: 1, status: "running", now });

      const rejected = yield* Effect.flip(
        eventSink.write({
          events: [
            threadCreatedEvent({ thread: makeThread(threadId, now), now }),
            runEvent({ type: "run.created", run, now }),
            runEvent({ type: "run.updated", run: { ...run, status: "cancelled" }, now }),
            runEvent({ type: "run.updated", run: { ...run, status: "waiting" }, now }),
          ],
        }),
      );
      assert.isTrue(isEventSinkIllegalTransitionError(rejected.cause));
    }),
  );

  it.effect("allows checkpoint rollback to retire a completed run", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:lifecycle:rollback");
      const runId = RunId.make("run:lifecycle:rollback");
      const run = makeRun({ threadId, runId, ordinal: 1, status: "completed", now });

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ thread: makeThread(threadId, now), now }),
          runEvent({ type: "run.created", run, now }),
          runEvent({ type: "run.updated", run: { ...run, status: "rolled_back" }, now }),
        ],
      });
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(
        projection.runs.find((candidate) => candidate.id === runId)?.status,
        "rolled_back",
      );
    }),
  );

  it.effect("blocks terminal resurrection at the storage layer, except during replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:lifecycle:trigger");
      const runId = RunId.make("run:lifecycle:trigger");
      const run = makeRun({ threadId, runId, ordinal: 1, status: "failed", now });
      yield* eventSink.write({
        events: [
          threadCreatedEvent({ thread: makeThread(threadId, now), now }),
          runEvent({ type: "run.created", run, now }),
        ],
      });

      const directWrite = sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'running'
        WHERE run_id = ${runId}
      `;
      const rejected = yield* Effect.result(directWrite);
      assert.equal(rejected._tag, "Failure");

      yield* sql`UPDATE orchestration_v2_projection_guard SET mode = 'replay' WHERE id = 1`;
      yield* directWrite;
      yield* sql`UPDATE orchestration_v2_projection_guard SET mode = 'enforcing' WHERE id = 1`;
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${runId}
      `;
      assert.equal(rows[0]?.status, "running");
      // Restore a terminal status so later sweeps in this shared database
      // ignore the row.
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'failed' WHERE run_id = ${runId}`;
    }),
  );

  it.effect("derives the thread shell status from the live run, not the newest row", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:lifecycle:shell-status");
      const running = makeRun({
        threadId,
        runId: RunId.make("run:lifecycle:shell-status:running"),
        ordinal: 1,
        status: "running",
        now,
      });
      const cancelledQueued = makeRun({
        threadId,
        runId: RunId.make("run:lifecycle:shell-status:cancelled"),
        ordinal: 2,
        status: "cancelled",
        now,
      });

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ thread: makeThread(threadId, now), now }),
          runEvent({ type: "run.created", run: running, now }),
          runEvent({ type: "run.created", run: cancelledQueued, now }),
        ],
      });
      const workingShell = yield* projectionStore.getThreadShell(threadId);
      assert.equal(workingShell?.status, "running");
      assert.equal(workingShell?.latestRunId, running.id);

      yield* eventSink.write({
        events: [runEvent({ type: "run.updated", run: { ...running, status: "completed" }, now })],
      });
      const settledShell = yield* projectionStore.getThreadShell(threadId);
      assert.equal(settledShell?.status, "cancelled");
      assert.equal(settledShell?.latestRunId, cancelledQueued.id);
    }),
  );

  it.effect(
    "janitor terminalizes orphaned runs and spares leased, queued-behind, and busy work",
    () =>
      Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const janitor = yield* RunJanitorV2;
        const runLease = yield* RunLeaseServiceV2;
        const outbox = yield* EffectOutboxV2;

        const now = yield* DateTime.now;
        const orphanThreadId = ThreadId.make("thread:lifecycle:janitor-orphan");
        const orphanRunId = RunId.make("run:lifecycle:janitor-orphan");
        const leasedThreadId = ThreadId.make("thread:lifecycle:janitor-leased");
        const leasedRunId = RunId.make("run:lifecycle:janitor-leased");
        const effectThreadId = ThreadId.make("thread:lifecycle:janitor-effect");
        const effectRunId = RunId.make("run:lifecycle:janitor-effect");
        yield* eventSink.write({
          events: [
            threadCreatedEvent({ thread: makeThread(orphanThreadId, now), now }),
            runEvent({
              type: "run.created",
              run: makeRun({
                threadId: orphanThreadId,
                runId: orphanRunId,
                ordinal: 1,
                status: "running",
                now,
              }),
              now,
            }),
            threadCreatedEvent({ thread: makeThread(leasedThreadId, now), now }),
            runEvent({
              type: "run.created",
              run: makeRun({
                threadId: leasedThreadId,
                runId: leasedRunId,
                ordinal: 1,
                status: "running",
                now,
              }),
              now,
            }),
            threadCreatedEvent({ thread: makeThread(effectThreadId, now), now }),
            runEvent({
              type: "run.created",
              run: makeRun({
                threadId: effectThreadId,
                runId: effectRunId,
                ordinal: 1,
                status: "waiting",
                now,
              }),
              now,
            }),
          ],
        });
        yield* outbox.enqueue([
          {
            id: `effect:lifecycle:janitor:${effectRunId}`,
            commandId: CommandId.make(`command:lifecycle:janitor:${effectRunId}`),
            threadId: effectThreadId,
            request: {
              type: "checkpoint.capture",
              runId: effectRunId,
              scopeId: CheckpointScopeId.make(`scope:${effectRunId}`),
            },
          },
        ]);

        // All three threads have fresh activity: nothing is old enough to sweep.
        const freshSweep = yield* janitor.sweepOnce;
        assert.equal(freshSweep.terminalizedRuns, 0);

        yield* TestClock.adjust("10 minutes");

        // The leased thread's run is owned by a live fiber for the duration of
        // the wrapped effect, so only the orphan falls.
        yield* runLease.withRunLease({ threadId: leasedThreadId, runId: leasedRunId })(
          Effect.gen(function* () {
            const sweep = yield* janitor.sweepOnce;
            assert.equal(sweep.terminalizedRuns, 1);
          }),
        );

        const orphanShell = yield* projectionStore.getThreadShell(orphanThreadId);
        assert.equal(orphanShell?.status, "cancelled");
        const leasedProjection = yield* projectionStore.getThreadProjection(leasedThreadId);
        assert.equal(leasedProjection.runs[0]?.status, "running");
        const effectProjection = yield* projectionStore.getThreadProjection(effectThreadId);
        assert.equal(effectProjection.runs[0]?.status, "waiting");

        // Lease released with its scope; the pending effect still shields the
        // waiting run, while the formerly leased run is now orphaned.
        const followUpSweep = yield* janitor.sweepOnce;
        assert.equal(followUpSweep.terminalizedRuns, 1);
        const leasedShell = yield* projectionStore.getThreadShell(leasedThreadId);
        assert.equal(leasedShell?.status, "cancelled");
        const effectShellAfter = yield* projectionStore.getThreadProjection(effectThreadId);
        assert.equal(effectShellAfter.runs[0]?.status, "waiting");

        // Once the durable work disappears without settling the run, the
        // shield is gone and the janitor reclaims it too.
        const retired = yield* outbox.cancelUnsettled({
          threadId: effectThreadId,
          effectTypes: ["checkpoint.capture"],
          reason: "test teardown",
        });
        assert.lengthOf(retired, 1);
        yield* TestClock.adjust("10 minutes");
        const finalSweep = yield* janitor.sweepOnce;
        assert.equal(finalSweep.terminalizedRuns, 1);
        const effectShellFinal = yield* projectionStore.getThreadShell(effectThreadId);
        assert.equal(effectShellFinal?.status, "cancelled");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resettles expired effect leases: replay-safe requeues, process-bound fails", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const now = yield* DateTime.now;
      const replayThreadId = ThreadId.make("thread:lifecycle:outbox-replay");
      const boundThreadId = ThreadId.make("thread:lifecycle:outbox-bound");
      yield* eventSink.write({
        events: [
          threadCreatedEvent({ thread: makeThread(replayThreadId, now), now }),
          threadCreatedEvent({ thread: makeThread(boundThreadId, now), now }),
        ],
      });
      yield* outbox.enqueue([
        {
          id: "effect:lifecycle:outbox-replay",
          commandId: CommandId.make("command:lifecycle:outbox-replay"),
          threadId: replayThreadId,
          request: {
            type: "checkpoint.capture",
            runId: RunId.make("run:lifecycle:outbox-replay"),
            scopeId: CheckpointScopeId.make("scope:lifecycle:outbox-replay"),
          },
        },
        {
          id: "effect:lifecycle:outbox-bound",
          commandId: CommandId.make("command:lifecycle:outbox-bound"),
          threadId: boundThreadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:lifecycle:outbox-bound"),
          },
        },
      ]);

      const firstClaim = yield* outbox.claimNext({
        workerId: "worker:test",
        leaseDurationMs: 30_000,
      });
      const secondClaim = yield* outbox.claimNext({
        workerId: "worker:test",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(firstClaim));
      assert.isTrue(Option.isSome(secondClaim));
      const replayFirstClaim = [firstClaim, secondClaim]
        .flatMap((claim) => (Option.isSome(claim) ? [claim.value] : []))
        .find((effect) => effect.id === "effect:lifecycle:outbox-replay");
      const staleOwner = replayFirstClaim?.leaseOwner ?? null;
      assert.isNotNull(staleOwner);

      // Nothing has expired yet.
      const early = yield* outbox.settleExpiredLeases({ maxAttempts: 5 });
      assert.deepEqual(early, { requeued: 0, failed: 0 });

      yield* TestClock.adjust("31 seconds");
      const settled = yield* outbox.settleExpiredLeases({ maxAttempts: 5 });
      assert.equal(settled.requeued, 1);
      assert.equal(settled.failed, 1);

      // The replay-safe effect is claimable again; the abandoned claimer's
      // stale token can no longer settle it.
      const reclaim = yield* outbox.claimNext({ workerId: "worker:test", leaseDurationMs: 30_000 });
      assert.isTrue(Option.isSome(reclaim));
      const reclaimed = Option.getOrThrow(reclaim);
      assert.equal(reclaimed.request.type, "checkpoint.capture");
      assert.notEqual(reclaimed.leaseOwner, staleOwner);
      assert.isFalse(
        yield* outbox.succeed({ effectId: reclaimed.id, workerId: staleOwner ?? "worker:test" }),
      );
      assert.isTrue(
        yield* outbox.succeed({
          effectId: reclaimed.id,
          workerId: reclaimed.leaseOwner ?? "worker:test",
        }),
      );

      const failed = yield* outbox.get("effect:lifecycle:outbox-bound");
      assert.equal(Option.getOrThrow(failed).status, "failed");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
