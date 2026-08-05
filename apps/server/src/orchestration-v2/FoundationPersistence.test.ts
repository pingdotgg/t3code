import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CommandReceiptStoreV2, layer as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import {
  layerWithOptions as effectWorkerLayerWithOptions,
  OrchestrationEffectExecutionError,
  OrchestrationEffectExecutorV2,
  OrchestrationEffectWorkerV2,
  runDaemonWithOptions as runEffectWorkerDaemonWithOptions,
} from "./EffectWorker.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const effectOutboxProvided = effectOutboxLayer.pipe(Layer.provide(databaseLayer));
const commandReceiptStoreProvided = commandReceiptStoreLayer.pipe(Layer.provide(databaseLayer));
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(
  Layer.provide(storesProvided),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  effectOutboxProvided,
  commandReceiptStoreProvided,
  idAllocatorLayer,
  projectionMaintenanceProvided,
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
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

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

it.layer(TestLayer)("orchestration V2 foundation persistence", (it) => {
  it.effect("paginates catch-up beyond the event-store read limit", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-large-catch-up");
      const thread = makeThread(threadId, now);
      const eventCount = 1_005;
      const events: Array<OrchestrationV2DomainEvent> = [
        threadCreatedEvent({ id: "event:foundation-catch-up:0", thread, now }),
        ...Array.from({ length: eventCount - 1 }, (_, index) => ({
          id: EventId.make(`event:foundation-catch-up:${index + 1}`),
          type: "thread.metadata-updated" as const,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...thread,
            title: `Catch-up update ${index + 1}`,
          },
        })),
      ];

      yield* eventSink.write({ events });
      const replayed = yield* eventSink.stream({ afterSequence: 0 }).pipe(
        Stream.take(eventCount),
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
      );

      assert.lengthOf(replayed, eventCount);
      assert.deepEqual(
        replayed.map((stored) => stored.sequence),
        Array.from({ length: eventCount }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("does not lose or duplicate events while transitioning from catch-up to live", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stream-race");
      const thread = makeThread(threadId, now);
      const created = yield* eventSink.write({
        events: [threadCreatedEvent({ id: "event:foundation-stream-race:0", thread, now })],
      });

      let afterSequence = created[0]!.sequence;
      for (let index = 1; index <= 32; index += 1) {
        const nextEvent = {
          id: EventId.make(`event:foundation-stream-race:${index}`),
          type: "thread.metadata-updated" as const,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: { ...thread, title: `Race update ${index}` },
        } satisfies OrchestrationV2DomainEvent;
        const reader = yield* eventSink
          .stream({ threadId, afterSequence })
          .pipe(Stream.runHead, Effect.forkChild);
        yield* Effect.yieldNow;
        const written = yield* eventSink.write({ events: [nextEvent] });
        const received = yield* Fiber.join(reader);
        if (Option.isNone(received)) {
          return yield* Effect.die("The event stream ended before delivering the live event.");
        }
        assert.equal(received.value.sequence, written[0]?.sequence);
        assert.equal(received.value.event.id, nextEvent.id);
        afterSequence = received.value.sequence;
      }
    }),
  );

  it.effect("replays shared provider-session payloads across every bound thread", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread:foundation-shared-session:first");
      const secondThreadId = ThreadId.make("thread:foundation-shared-session:second");
      const providerSessionId = ProviderSessionId.make("provider-session:foundation:shared");
      const firstSession = {
        id: providerSessionId,
        driver: providerDriver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace/first",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const secondSession = { ...firstSession, cwd: "/workspace/second" };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-shared-session:first-thread",
            thread: makeThread(firstThreadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-shared-session:first-attachment"),
            type: "provider-session.attached",
            threadId: firstThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: firstSession,
          },
          threadCreatedEvent({
            id: "event:foundation-shared-session:second-thread",
            thread: makeThread(secondThreadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-shared-session:second-attachment"),
            type: "provider-session.attached",
            threadId: secondThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: secondSession,
          },
        ],
      });

      assert.equal(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions[0]?.cwd,
        secondSession.cwd,
      );
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
    }),
  );

  it.effect("compacts superseded state events, imported v1 events, and legacy receipts", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:foundation-compact");
      const thread = makeThread(threadId, now);
      const messageId = MessageId.make("message:foundation-compact");
      const threadStateEvent = (
        suffix: string,
        type: "thread.visited" | "thread.metadata-updated",
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type,
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...thread, lastVisitedAt: now },
      });
      const messageEvent = (suffix: string, text: string): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-compact:create", thread, now }),
          threadStateEvent("meta", "thread.metadata-updated"),
          threadStateEvent("visit-1", "thread.visited"),
          threadStateEvent("visit-2", "thread.visited"),
          messageEvent("message-1", "streaming"),
          messageEvent("message-2", "final"),
        ],
      });

      // A fully imported legacy thread: its v1 events and pre-migration
      // receipts are dead weight; a still-pending import keeps its rows.
      const importedV1ThreadId = "thread:foundation-compact-v1-imported";
      const pendingV1ThreadId = "thread:foundation-compact-v1-pending";
      const insertV1Event = (threadIdValue: string, version: number) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        )
        VALUES (
          ${`event:v1:${threadIdValue}:${version}`}, 'thread', ${threadIdValue}, ${version},
          'thread.message-appended', ${nowIso}, 'user', '{}', '{}', 1
        )
      `;
      yield* insertV1Event(importedV1ThreadId, 1);
      yield* insertV1Event(importedV1ThreadId, 2);
      yield* insertV1Event(pendingV1ThreadId, 1);
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports (
          thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
          imported_message_count, last_error
        )
        VALUES
          (${importedV1ThreadId}, ${nowIso}, ${nowIso}, ${nowIso}, 2, NULL),
          (${pendingV1ThreadId}, ${nowIso}, ${nowIso}, NULL, 0, NULL)
        ON CONFLICT(thread_id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
        )
        VALUES
          ('command:foundation-compact:legacy', 'thread', ${importedV1ThreadId}, ${nowIso}, 1, 'accepted', 'legacy'),
          ('command:foundation-compact:pending', 'thread', ${pendingV1ThreadId}, ${nowIso}, 1, 'accepted', 'legacy')
        ON CONFLICT(command_id) DO NOTHING
      `;

      const summary = yield* maintenance.compactEventStore;
      // meta + visit-1 (superseded thread state), message-1, and the two
      // imported v1 events.
      assert.isAtLeast(summary.deletedEventCount, 5);
      assert.isAtLeast(summary.deletedReceiptCount, 1);

      const remaining = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
        ORDER BY sequence ASC
      `;
      assert.deepEqual(
        remaining.map((row) => row.event_id),
        [
          "event:foundation-compact:create",
          "event:foundation-compact:visit-2",
          "event:foundation-compact:message-2",
        ],
      );

      const remainingV1 = yield* sql<{ readonly stream_id: string }>`
        SELECT stream_id
        FROM orchestration_events
        WHERE application_event_version = 1
          AND stream_id IN (${importedV1ThreadId}, ${pendingV1ThreadId})
      `;
      assert.deepEqual(
        remainingV1.map((row) => row.stream_id),
        [pendingV1ThreadId],
      );

      const remainingReceipts = yield* sql<{ readonly command_id: string }>`
        SELECT command_id
        FROM orchestration_command_receipts
        WHERE command_id IN ('command:foundation-compact:legacy', 'command:foundation-compact:pending')
      `;
      assert.deepEqual(
        remainingReceipts.map((row) => row.command_id),
        ["command:foundation-compact:pending"],
      );

      // Replay across the deletion gaps must still produce a valid projection.
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
    }),
  );

  it.effect("verifies and rebuilds projections with cross-thread subagent relations", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const parentThreadId = ThreadId.make("thread:foundation-cross-thread:parent");
      const childThreadId = ThreadId.make("thread:foundation-cross-thread:child");
      const childProviderThreadId = ProviderThreadId.make(
        "provider-thread:foundation-cross-thread:child",
      );
      const subagentId = NodeId.make("subagent:foundation-cross-thread");
      const spawnTransferId = ContextTransferId.make("transfer:foundation-cross-thread:spawn");
      const resultTransferId = ContextTransferId.make("transfer:foundation-cross-thread:result");
      const parentThread = makeThread(parentThreadId, now);
      const childThread = {
        ...makeThread(childThreadId, now),
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        lineage: {
          parentThreadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: parentThreadId,
        },
      };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-cross-thread:parent",
            thread: parentThread,
            now,
          }),
          threadCreatedEvent({
            id: "event:foundation-cross-thread:child",
            thread: childThread,
            now,
          }),
          {
            id: EventId.make("event:foundation-cross-thread:subagent"),
            type: "subagent.updated",
            threadId: parentThreadId,
            nodeId: subagentId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: subagentId,
              threadId: parentThreadId,
              runId: null,
              parentNodeId: NodeId.make("node:foundation-cross-thread:parent"),
              origin: "app_owned",
              createdBy: "agent",
              driver: providerDriver,
              providerInstanceId,
              providerThreadId: childProviderThreadId,
              childThreadId,
              nativeTaskRef: null,
              prompt: "Inspect the child flow",
              title: "Cross-thread child",
              model: modelSelection.model,
              status: "completed",
              result: "done",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:spawn-transfer"),
            type: "context-transfer.created",
            threadId: childThreadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: spawnTransferId,
              type: "subagent_spawn",
              sourceThreadId: parentThreadId,
              targetThreadId: childThreadId,
              sourcePoint: { threadId: parentThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "agent",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:provider-thread"),
            type: "provider-thread.updated",
            threadId: parentThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: childProviderThreadId,
              driver: providerDriver,
              providerInstanceId,
              providerSessionId: null,
              appThreadId: childThreadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:result-transfer"),
            type: "context-transfer.created",
            threadId: parentThreadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: resultTransferId,
              type: "subagent_result",
              sourceThreadId: childThreadId,
              targetThreadId: parentThreadId,
              sourcePoint: { threadId: childThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "system",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
        ],
      });

      const assertCrossThreadProjection = Effect.gen(function* () {
        const parent = yield* projectionStore.getThreadProjection(parentThreadId);
        const child = yield* projectionStore.getThreadProjection(childThreadId);
        const expectedTransferIds = [spawnTransferId, resultTransferId].toSorted();
        assert.deepEqual(
          parent.contextTransfers.map((transfer) => transfer.id).toSorted(),
          expectedTransferIds,
        );
        assert.deepEqual(
          child.contextTransfers.map((transfer) => transfer.id).toSorted(),
          expectedTransferIds,
        );
        assert.deepEqual(
          parent.providerThreads.map((providerThread) => providerThread.id),
          [childProviderThreadId],
        );
        assert.equal(child.thread.activeProviderThreadId, childProviderThreadId);
      });

      yield* assertCrossThreadProjection;
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCrossThreadProjection;
    }),
  );

  it.effect(
    "rolls back events, projections, receipts, and effects after a projection failure",
    () =>
      Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const eventStore = yield* EventStoreV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const commandId = CommandId.make("command:foundation-atomic-failure");
        const threadId = ThreadId.make("thread:foundation-atomic-failure");
        const scopeId = CheckpointScopeId.make("scope:foundation-atomic-failure");
        const checkpoint = (index: number) => ({
          id: CheckpointId.make(`checkpoint:foundation-atomic-failure:${index}`),
          threadId,
          scopeId,
          runId: null,
          nodeId: NodeId.make("node:foundation-atomic-failure"),
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: null,
          ref: CheckpointRef.make(`checkpoint-ref:foundation-atomic-failure:${index}`),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        });
        const events = [1, 2].map(
          (index) =>
            ({
              id: EventId.make(`event:foundation-atomic-failure:${index}`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: checkpoint(index),
            }) satisfies OrchestrationV2DomainEvent,
        );

        const exit = yield* Effect.exit(
          eventSink.commitCommand({
            commandId,
            threadId,
            commandType: "checkpoint.atomicity-test",
            acceptedAt: now,
            events,
            effects: [
              {
                id: "effect:foundation-atomic-failure",
                commandId,
                threadId,
                request: {
                  type: "provider-turn.start",
                  runId: RunId.make("run:foundation-atomic-failure"),
                },
              },
            ],
          }),
        );
        assert.equal(exit._tag, "Failure");
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        assert.deepEqual(
          yield* eventStore.readByCommandId({ commandId }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
          [],
        );
        const checkpointRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ${threadId}
      `;
        assert.equal(checkpointRows[0]?.count, 0);
      }),
  );

  it.effect("keeps one durable effect across command retries and executes it after recovery", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const now = yield* DateTime.now;
      const commandId = CommandId.make("command:foundation-effect-recovery");
      const threadId = ThreadId.make("thread:foundation-effect-recovery");
      const thread = makeThread(threadId, now);
      const event = threadCreatedEvent({
        id: "event:foundation-effect-recovery",
        thread,
        now,
      });
      const effect = {
        id: "effect:foundation-effect-recovery",
        commandId,
        threadId,
        request: {
          type: "provider-turn.start" as const,
          runId: RunId.make("run:foundation-effect-recovery"),
        },
      };

      const first = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.effect-recovery",
        acceptedAt: now,
        events: [event],
        effects: [effect],
      });
      const retry = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.effect-recovery",
        acceptedAt: now,
        events: [event],
        effects: [effect],
      });

      assert.isTrue(first.committed);
      assert.isFalse(retry.committed);
      assert.equal(retry.receipt.resultSequence, first.receipt.resultSequence);
      assert.lengthOf(retry.storedEvents, 1);
      assert.lengthOf(yield* outbox.listByCommandId(commandId), 1);

      const executionCount = yield* Ref.make(0);
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({ workerId: "recovery-worker" }).pipe(
        Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)),
      );
      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        assert.isTrue(yield* worker.runOnce);
        assert.isFalse(yield* worker.runOnce);
      }).pipe(Effect.provide(workerLayer));

      assert.equal(yield* Ref.get(executionCount), 1);
      const storedEffect = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(storedEffect));
      if (Option.isSome(storedEffect)) {
        assert.equal(storedEffect.value.status, "succeeded");
      }
    }),
  );

  it.effect("does not wake claimers for effects from an idempotent command retry", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const now = yield* DateTime.now;
      const commandId = CommandId.make("command:foundation-idempotent-wakeup");
      const threadId = ThreadId.make("thread:foundation-idempotent-wakeup");
      const input = {
        commandId,
        threadId,
        commandType: "foundation.idempotent-wakeup",
        acceptedAt: now,
        events: [
          threadCreatedEvent({
            id: "event:foundation-idempotent-wakeup",
            thread: makeThread(threadId, now),
            now,
          }),
        ],
        effects: [
          {
            id: "effect:foundation-idempotent-wakeup",
            commandId,
            threadId,
            request: { type: "terminal.cleanup" as const },
          },
        ],
      };

      assert.isTrue((yield* eventSink.commitCommand(input)).committed);
      yield* outbox.awaitAvailable;
      assert.isFalse((yield* eventSink.commitCommand(input)).committed);

      const unexpectedWake = yield* outbox.awaitAvailable.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(unexpectedWake.pollUnsafe());
    }).pipe(Effect.provide(Layer.fresh(TestLayer))),
  );

  it.effect("does not publish a stale provider start after an interrupt wins", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stale-provider-start");
      const runId = RunId.make("run:foundation-stale-provider-start");
      const attemptId = RunAttemptId.make("run-attempt:foundation-stale-provider-start");
      const thread = makeThread(threadId, now);
      const startingRun: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:foundation-stale-provider-start"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        status: "starting",
        queuePosition: null,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-stale-provider-start:thread",
            thread,
            now,
          }),
          {
            id: EventId.make("event:foundation-stale-provider-start:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: startingRun,
          },
        ],
      });

      const reachedPrecommitGap = yield* Deferred.make<void>();
      const releaseStaleStart = yield* Deferred.make<void>();
      const providerStartCount = yield* Ref.make(0);
      const staleStartFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(reachedPrecommitGap, undefined);
        yield* Deferred.await(releaseStaleStart);
        const result = yield* eventSink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "starting",
          events: [
            {
              id: EventId.make("event:foundation-stale-provider-start:running"),
              type: "run.updated",
              threadId,
              runId,
              providerInstanceId,
              occurredAt: now,
              payload: { ...startingRun, status: "running", startedAt: now },
            },
          ],
        });
        if (result.committed) {
          yield* Ref.update(providerStartCount, (count) => count + 1);
        }
        return result;
      }).pipe(Effect.forkChild);

      yield* Deferred.await(reachedPrecommitGap);
      const interruptedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-stale-provider-start:cancelled"),
            type: "run.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: interruptedAt,
            payload: {
              ...startingRun,
              status: "cancelled",
              completedAt: interruptedAt,
            },
          },
        ],
      });
      yield* Deferred.succeed(releaseStaleStart, undefined);

      const staleResult = yield* Fiber.join(staleStartFiber);
      assert.isFalse(staleResult.committed);
      assert.deepEqual(staleResult.storedEvents, []);
      assert.equal(yield* Ref.get(providerStartCount), 0);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "cancelled");
    }),
  );

  it.effect("guards post-terminal provider-thread writes by attempt and run ordinal", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-provider-thread-owner");
      const runId = RunId.make("run:foundation-provider-thread-owner");
      const attemptId = RunAttemptId.make("attempt:foundation-provider-thread-owner");
      const replacementAttemptId = RunAttemptId.make(
        "attempt:foundation-provider-thread-owner:replacement",
      );
      const rootNodeId = NodeId.make("node:foundation-provider-thread-owner");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:foundation-provider-thread-owner",
      );
      const thread = makeThread(threadId, now);
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:foundation-provider-thread-owner"),
        rootNodeId,
        activeAttemptId: attemptId,
        status: "completed",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      const baseProviderThread = {
        id: providerThreadId,
        driver: providerDriver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [] as const,
        forkedFrom: null,
        pendingBackgroundTasks: [
          { taskId: "bg-owner", description: "sleep 20", taskType: "local_bash" },
        ],
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-provider-thread-owner:thread",
            thread,
            now,
          }),
          {
            id: EventId.make("event:foundation-provider-thread-owner:run"),
            type: "run.created",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("event:foundation-provider-thread-owner:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: baseProviderThread,
          },
        ],
      });

      const ownedClear = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:clear"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              ...baseProviderThread,
              pendingBackgroundTasks: [],
              updatedAt: now,
            },
          },
        ],
      });
      assert.isTrue(ownedClear.committed);
      assert.equal(ownedClear.storedEvents.length, 1);

      const afterReplacement = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:replacement-attempt"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...run,
              activeAttemptId: replacementAttemptId,
              status: "running",
            },
          },
        ],
      });

      const supersededAttemptWrite = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:superseded-attempt"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...baseProviderThread,
              status: "active",
              pendingBackgroundTasks: [
                {
                  taskId: "bg-superseded",
                  description: "should not land",
                  taskType: "local_bash",
                },
              ],
              updatedAt: afterReplacement,
            },
          },
        ],
      });
      assert.isFalse(supersededAttemptWrite.committed);
      assert.deepEqual(supersededAttemptWrite.storedEvents, []);

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:replacement-completed"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...run,
              activeAttemptId: replacementAttemptId,
            },
          },
          {
            id: EventId.make("event:foundation-provider-thread-owner:newer-run"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...baseProviderThread,
              lastRunOrdinal: 2,
              status: "active",
              pendingBackgroundTasks: [],
              updatedAt: afterReplacement,
            },
          },
        ],
      });

      const staleOrdinalWrite = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: replacementAttemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:stale-ordinal"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: baseProviderThread,
          },
        ],
      });
      assert.isFalse(staleOrdinalWrite.committed);
      assert.deepEqual(staleOrdinalWrite.storedEvents, []);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      assert.isDefined(providerThread);
      assert.equal(providerThread?.lastRunOrdinal, 2);
      assert.equal(providerThread?.status, "active");
      assert.deepEqual(providerThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("interrupts a running process-bound effect when it is cancelled", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-cancel-running-effect");
      const threadId = ThreadId.make("thread:foundation-cancel-running-effect");
      const effectId = "effect:foundation-cancel-running-effect";
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-cancel-running-effect"),
          },
        },
      ]);

      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined).pipe(Effect.ignore),
              ),
            ),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "cancellation-worker",
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        const workerFiber = yield* worker.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const cancelledEffectIds = yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "The owning run was interrupted.",
        });
        assert.deepEqual(cancelledEffectIds, [effectId]);
        yield* outbox.signalCancellations(cancelledEffectIds);
        assert.isTrue(yield* Fiber.join(workerFiber));
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(workerLayer));

      const cancelled = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(cancelled));
      if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");
    }),
  );

  it.effect("treats cancellation between execution and settlement as a normal outcome", () =>
    Effect.gen(function* () {
      const effectId = "effect:foundation-cancel-before-settlement";
      const threadId = ThreadId.make("thread:foundation-cancel-before-settlement");
      const commandId = CommandId.make("command:foundation-cancel-before-settlement");
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimedEffect = {
        id: effectId,
        commandId,
        threadId,
        request: { type: "terminal.cleanup" as const },
        status: "running" as const,
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "settlement-race-worker",
        leaseExpiresAt: now,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      };
      const outboxLayer = Layer.mock(EffectOutboxV2)({
        claimNext: () => Effect.succeed(Option.some(claimedEffect)),
        awaitCancellation: () => Effect.never,
        clearCancellation: () => Effect.void,
        succeed: () => Effect.succeed(false),
        get: () =>
          Effect.succeed(
            Option.some({
              ...claimedEffect,
              status: "cancelled" as const,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: now,
            }),
          ),
      });
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "settlement-race-worker",
      }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

      assert.isTrue(
        yield* OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce),
          Effect.provide(workerLayer),
        ),
      );
    }),
  );

  it.effect("does not start an effect that was cancelled during claim registration", () =>
    Effect.gen(function* () {
      const effectId = "effect:foundation-cancelled-during-claim";
      const threadId = ThreadId.make("thread:foundation-cancelled-during-claim");
      const commandId = CommandId.make("command:foundation-cancelled-during-claim");
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimedEffect = {
        id: effectId,
        commandId,
        threadId,
        request: { type: "terminal.cleanup" as const },
        status: "running" as const,
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "claim-cancellation-worker",
        leaseExpiresAt: now,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      };
      const executionCount = yield* Ref.make(0);
      const outboxLayer = Layer.mock(EffectOutboxV2)({
        claimNext: () => Effect.succeed(Option.some(claimedEffect)),
        get: () =>
          Effect.succeed(
            Option.some({
              ...claimedEffect,
              status: "cancelled" as const,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: now,
            }),
          ),
        clearCancellation: () => Effect.void,
        awaitCancellation: () => Effect.never,
      });
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "claim-cancellation-worker",
      }).pipe(Layer.provide(Layer.merge(outboxLayer, executorLayer)));

      assert.isTrue(
        yield* OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce),
          Effect.provide(workerLayer),
        ),
      );
      assert.equal(yield* Ref.get(executionCount), 0);
    }),
  );

  it.effect("allows only one worker to claim an available effect", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-exclusive-claim");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-exclusive-claim",
          commandId,
          threadId: ThreadId.make("thread:foundation-exclusive-claim"),
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-exclusive-claim"),
          },
        },
      ]);

      const claims = yield* Effect.all(
        [
          outbox.claimNext({ workerId: "worker-a", leaseDurationMs: 30_000 }),
          outbox.claimNext({ workerId: "worker-b", leaseDurationMs: 30_000 }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(claims.filter(Option.isSome).length, 1);
      assert.equal(claims.filter(Option.isNone).length, 1);
      const claimedByA = claims[0];
      const claimedByB = claims[1];
      if (Option.isSome(claimedByA)) {
        yield* outbox.succeed({ effectId: claimedByA.value.id, workerId: "worker-a" });
      }
      if (Option.isSome(claimedByB)) {
        yield* outbox.succeed({ effectId: claimedByB.value.id, workerId: "worker-b" });
      }
    }),
  );

  it.effect("runs title generation beside critical work while serializing each lane", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-title-effect-lane");
      const threadId = ThreadId.make("thread:foundation-title-effect-lane");
      const titleEffectId = "effect:foundation-title-effect-lane:a-title";
      const providerEffectId = "effect:foundation-title-effect-lane:b-provider";
      const nextTitleEffectId = "effect:foundation-title-effect-lane:c-title";
      const nextCriticalEffectId = "effect:foundation-title-effect-lane:d-critical";
      yield* outbox.enqueue([
        {
          id: titleEffectId,
          commandId,
          threadId,
          request: {
            type: "thread-title.generate",
            kind: {
              type: "initial",
              messageId: MessageId.make("message:foundation-title-effect-lane"),
            },
          },
        },
        {
          id: providerEffectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-title-effect-lane"),
          },
        },
        {
          id: nextTitleEffectId,
          commandId,
          threadId,
          request: { type: "thread-title.generate", kind: { type: "regenerate" } },
        },
        {
          id: nextCriticalEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const title = yield* outbox.claimNext({
        workerId: "title-lane-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(title));
      if (Option.isNone(title)) return;
      assert.equal(title.value.id, titleEffectId);

      const provider = yield* outbox.claimNext({
        workerId: "critical-lane-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(provider));
      if (Option.isNone(provider)) return;
      assert.equal(provider.value.id, providerEffectId);

      assert.isTrue(
        Option.isNone(
          yield* outbox.claimNext({
            workerId: "blocked-lanes-worker",
            leaseDurationMs: 30_000,
          }),
        ),
      );

      yield* outbox.succeed({
        effectId: provider.value.id,
        workerId: "critical-lane-worker",
      });
      const nextCritical = yield* outbox.claimNext({
        workerId: "critical-lane-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(nextCritical));
      if (Option.isNone(nextCritical)) return;
      assert.equal(nextCritical.value.id, nextCriticalEffectId);
      yield* outbox.succeed({
        effectId: nextCritical.value.id,
        workerId: "critical-lane-worker",
      });

      yield* outbox.succeed({
        effectId: title.value.id,
        workerId: "title-lane-worker",
      });
      const nextTitle = yield* outbox.claimNext({
        workerId: "title-lane-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(nextTitle));
      if (Option.isSome(nextTitle)) {
        assert.equal(nextTitle.value.id, nextTitleEffectId);
        yield* outbox.succeed({
          effectId: nextTitle.value.id,
          workerId: "title-lane-worker",
        });
      }
    }),
  );

  it.effect("ignores deadlines blocked by a running effect on the same thread", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const now = yield* DateTime.now;
      const future = DateTime.add(now, { seconds: 10 });
      const commandId = CommandId.make("command:foundation-next-claimable");
      const blockedThreadId = ThreadId.make("thread:foundation-next-claimable:blocked");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-next-claimable:a1",
          commandId,
          threadId: blockedThreadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: "effect:foundation-next-claimable:a2",
          commandId,
          threadId: blockedThreadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: "effect:foundation-next-claimable:b1",
          commandId,
          threadId: ThreadId.make("thread:foundation-next-claimable:future"),
          request: { type: "terminal.cleanup" },
          availableAt: future,
        },
      ]);

      const claimed = yield* outbox.claimNext({
        workerId: "next-claimable-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(claimed));
      if (Option.isNone(claimed)) return;
      assert.equal(claimed.value.id, "effect:foundation-next-claimable:a1");

      const whileBlocked = yield* outbox.nextClaimableAt;
      assert.isTrue(Option.isSome(whileBlocked));
      if (Option.isSome(whileBlocked)) {
        assert.equal(DateTime.toEpochMillis(whileBlocked.value), DateTime.toEpochMillis(future));
      }

      yield* outbox.succeed({
        effectId: claimed.value.id,
        workerId: "next-claimable-worker",
      });
      const afterCompletion = yield* outbox.nextClaimableAt;
      assert.isTrue(Option.isSome(afterCompletion));
      if (Option.isSome(afterCompletion)) {
        assert.isAtMost(DateTime.toEpochMillis(afterCompletion.value), DateTime.toEpochMillis(now));
      }

      const unblocked = yield* outbox.claimNext({
        workerId: "next-claimable-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(unblocked));
      if (Option.isSome(unblocked)) {
        assert.equal(unblocked.value.id, "effect:foundation-next-claimable:a2");
        yield* outbox.succeed({
          effectId: unblocked.value.id,
          workerId: "next-claimable-worker",
        });
      }
      yield* outbox.cancelUnsettled({
        threadId: ThreadId.make("thread:foundation-next-claimable:future"),
        effectTypes: ["terminal.cleanup"],
        reason: "Test cleanup.",
      });
    }),
  );

  it.effect("does not emit a SQL span for an empty safety claim", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const spans: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            spans.push(span.name);
          };
          return span;
        },
      });

      const claim = yield* outbox
        .claimNext({ workerId: "idle-safety-worker", leaseDurationMs: 30_000 })
        .pipe(Effect.withTracer(tracer));

      assert.isTrue(Option.isNone(claim));
      assert.notInclude(spans, "sql.execute");
    }).pipe(Effect.provide(Layer.fresh(effectOutboxProvided))),
  );

  it.effect("wakes claimers when cancellation unblocks same-thread work", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-cancellation-wakeup");
      const threadId = ThreadId.make("thread:foundation-cancellation-wakeup");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-cancellation-wakeup:a-running",
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-cancellation-wakeup"),
          },
        },
        {
          id: "effect:foundation-cancellation-wakeup:b-pending",
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const running = yield* outbox.claimNext({
        workerId: "cancellation-wakeup-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(running));
      if (Option.isNone(running)) return;
      assert.equal(running.value.request.type, "provider-turn.start");

      const cancelledEffectIds = yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "Test cancellation wakeup.",
      });
      yield* outbox.signalCancellations(cancelledEffectIds);

      const wake = yield* outbox.awaitAvailable.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isDefined(wake.pollUnsafe());

      const unblocked = yield* outbox.claimNext({
        workerId: "cancellation-wakeup-worker",
        leaseDurationMs: 30_000,
      });
      assert.isTrue(Option.isSome(unblocked));
      if (Option.isSome(unblocked)) {
        assert.equal(unblocked.value.request.type, "terminal.cleanup");
        yield* outbox.succeed({
          effectId: unblocked.value.id,
          workerId: "cancellation-wakeup-worker",
        });
      }
    }).pipe(Effect.provide(Layer.fresh(effectOutboxProvided))),
  );

  it.effect("executes a retry at its durable deadline instead of the liveness interval", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const effectId = "effect:foundation-durable-retry-deadline";
      const commandId = CommandId.make("command:foundation-durable-retry-deadline");
      const threadId = ThreadId.make("thread:foundation-durable-retry-deadline");
      const executions = yield* Ref.make(0);
      const completed = yield* Deferred.make<void>();
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(executions, (count) => count + 1);
              if (attempt === 1) {
                return yield* new OrchestrationEffectExecutionError({
                  effectId,
                  effectType: "terminal.cleanup",
                  cause: "simulated retry",
                });
              }
              yield* Deferred.succeed(completed, undefined);
            }),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "durable-retry-deadline-worker",
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        yield* runEffectWorkerDaemonWithOptions({
          concurrency: 1,
          livenessPollIntervalMs: 30_000,
        }).pipe(Effect.forkScoped);
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId,
            threadId,
            request: { type: "terminal.cleanup" },
          },
        ]);
        yield* outbox.notifyAvailable();

        let retryScheduled = false;
        while (!retryScheduled) {
          const effect = yield* outbox.get(effectId);
          retryScheduled =
            Option.isSome(effect) &&
            effect.value.status === "pending" &&
            effect.value.attemptCount === 1;
          if (!retryScheduled) yield* Effect.yieldNow;
        }

        yield* TestClock.adjust("99 millis");
        assert.equal(yield* Ref.get(executions), 1);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(completed);
        assert.equal(yield* Ref.get(executions), 2);
      }).pipe(Effect.provide(workerLayer), Effect.scoped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("runs distinct threads concurrently while serializing effects within a thread", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-concurrent-effects");
      const threadA = ThreadId.make("thread:foundation-concurrent-effects:a");
      const threadB = ThreadId.make("thread:foundation-concurrent-effects:b");
      const effectA1 = "effect:foundation-concurrent-effects:a1";
      const effectA2 = "effect:foundation-concurrent-effects:a2";
      const effectB1 = "effect:foundation-concurrent-effects:b1";
      const startedA1 = yield* Deferred.make<void>();
      const startedA2 = yield* Deferred.make<void>();
      const startedB1 = yield* Deferred.make<void>();
      const releaseA1 = yield* Deferred.make<void>();
      const releaseA2 = yield* Deferred.make<void>();
      const releaseB1 = yield* Deferred.make<void>();
      const gates = new Map([
        [effectA1, { started: startedA1, release: releaseA1 }],
        [effectA2, { started: startedA2, release: releaseA2 }],
        [effectB1, { started: startedB1, release: releaseB1 }],
      ]);
      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: (effect) => {
            const gate = gates.get(effect.id);
            if (gate === undefined) return Effect.die(`Missing gate for ${effect.id}`);
            return Deferred.succeed(gate.started, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            );
          },
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "concurrency-worker",
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        yield* runEffectWorkerDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        // Let both slots reach the idle wait before work becomes available.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* outbox.enqueue([
          {
            id: effectA1,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a1"),
            },
          },
          {
            id: effectA2,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a2"),
            },
          },
          {
            id: effectB1,
            commandId,
            threadId: threadB,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:b1"),
            },
          },
        ]);
        yield* outbox.notifyAvailable(3);

        yield* Effect.all([Deferred.await(startedA1), Deferred.await(startedB1)]);
        assert.isFalse(yield* Deferred.isDone(startedA2));

        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.succeed(releaseB1, undefined);
        yield* Deferred.await(startedA2);
        yield* Deferred.succeed(releaseA2, undefined);
        let settled = false;
        while (!settled) {
          settled = (yield* outbox.listByCommandId(commandId)).every(
            (effect) => effect.status === "succeeded",
          );
          if (!settled) yield* Effect.yieldNow;
        }
      }).pipe(Effect.provide(workerLayer), Effect.scoped);
    }),
  );

  it.effect("does not reclaim a running effect after its process-local lease expires", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command:foundation-no-live-reclaim");
      const threadId = ThreadId.make("thread:foundation-no-live-reclaim");
      const firstEffectId = "effect:foundation-no-live-reclaim:first";
      const secondEffectId = "effect:foundation-no-live-reclaim:second";
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const executions = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* outbox.enqueue([
        {
          id: firstEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: secondEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const executorLayer = Layer.succeed(
        OrchestrationEffectExecutorV2,
        OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Ref.update(executions, (current) => [...current, effect.id]).pipe(
              Effect.andThen(
                effect.id === firstEffectId
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      const workerLayer = effectWorkerLayerWithOptions({
        workerId: "no-live-reclaim-worker",
        leaseDurationMs: 1,
      }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

      yield* Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        const firstFiber = yield* worker.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET lease_expires_at = '1970-01-01T00:00:00.000Z'
          WHERE effect_id = ${firstEffectId}
        `;

        assert.isFalse(yield* worker.runOnce);
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId]);

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.isTrue(yield* Fiber.join(firstFiber));
        assert.isTrue(yield* worker.runOnce);
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId, secondEffectId]);
      }).pipe(Effect.provide(workerLayer));
    }),
  );

  it.effect(
    "retires live provider effects and requeues replay-safe effects after process loss",
    () =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutboxV2;
        const commandId = CommandId.make("command:foundation-reclaim-running");
        yield* outbox.enqueue([
          {
            id: "effect:a-foundation-cancel-provider-turn",
            commandId,
            threadId: ThreadId.make("thread:foundation-reclaim-running"),
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-reclaim-running"),
            },
          },
          {
            id: "effect:b-foundation-requeue-cleanup",
            commandId,
            threadId: ThreadId.make("thread:foundation-reclaim-cleanup"),
            request: { type: "terminal.cleanup" },
          },
        ]);
        assert.isTrue(
          Option.isSome(
            yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 30_000 }),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 30_000 }),
          ),
        );
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
          cancelled: 1,
          requeued: 1,
        });
        const cancelled = yield* outbox.get("effect:a-foundation-cancel-provider-turn");
        assert.isTrue(Option.isSome(cancelled));
        if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");

        const reclaimed = yield* outbox.claimNext({
          workerId: "recovery-worker",
          leaseDurationMs: 30_000,
        });
        assert.isTrue(Option.isSome(reclaimed));
        if (Option.isSome(reclaimed)) {
          assert.equal(reclaimed.value.request.type, "terminal.cleanup");
          assert.equal(reclaimed.value.attemptCount, 2);
        }
      }),
  );

  it.effect("atomically cancels stale runs and their process-bound effects", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-process-loss");
      const runId = RunId.make("run:foundation-process-loss");
      const commandId = CommandId.make("command:foundation-process-loss");
      const thread = makeThread(threadId, now);
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.process-loss",
        acceptedAt: now,
        events: [
          threadCreatedEvent({ id: "event:foundation-process-loss:thread", thread, now }),
          {
            id: EventId.make("event:foundation-process-loss:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:foundation-process-loss"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "starting",
              queuePosition: null,
              requestedAt: now,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
        effects: [
          {
            id: "effect:foundation-process-loss",
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ],
      });
      assert.isTrue(
        Option.isSome(
          yield* outbox.claimNext({ workerId: "crashed-worker", leaseDurationMs: 30_000 }),
        ),
      );

      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provideService(
          OrchestrationEffectWorkerV2,
          OrchestrationEffectWorkerV2.of({
            awaitWork: Effect.void,
            runOnce: Effect.succeed(false),
            nextClaimableAt: Effect.succeed(Option.none()),
            drain: () => Effect.succeed(0),
          }),
        ),
      );
      const first = yield* recovery.recover;
      assert.equal(first.terminalizedRuns, 1);
      assert.equal(first.retiredEffects, 1);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "cancelled");
      const effect = yield* outbox.get("effect:foundation-process-loss");
      assert.isTrue(Option.isSome(effect));
      if (Option.isSome(effect)) assert.equal(effect.value.status, "cancelled");

      const second = yield* recovery.recover;
      assert.equal(second.terminalizedRuns, 0);
      assert.equal(second.retiredEffects, 0);
    }),
  );

  it.effect("allocates collision-free positions beyond 100 items and rebuilds equivalently", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-many-items");
      const runId = RunId.make("run:foundation-many-items");
      const providerThreadId = ProviderThreadId.make("provider-thread:foundation-many-items");
      const thread = makeThread(threadId, now);
      const providerThreadEvent = {
        id: EventId.make("event:foundation-many-items:provider-thread"),
        type: "provider-thread.updated" as const,
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: providerDriver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies OrchestrationV2DomainEvent;
      const runEvent = {
        id: EventId.make("event:foundation-many-items:run"),
        type: "run.created" as const,
        threadId,
        runId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:foundation-many-items"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed" as const,
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      } satisfies OrchestrationV2DomainEvent;
      const items = Array.from({ length: 151 }, (_, index) => ({
        id: TurnItemId.make(`turn-item:foundation-many-items:${index}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index % 3,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool" as const,
        toolName: `tool-${index}`,
        input: { index },
        output: { completed: true },
      }));
      const itemEvents = items.map(
        (item, index) =>
          ({
            id: EventId.make(`event:foundation-many-items:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: item,
          }) satisfies OrchestrationV2DomainEvent,
      );

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-many-items:thread", thread, now }),
          providerThreadEvent,
          runEvent,
          ...itemEvents,
        ],
      });
      const beforeUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(beforeUpdate.thread.activeProviderThreadId, providerThreadId);
      const ordinals = beforeUpdate.turnItems.map((item) => item.ordinal);
      assert.lengthOf(ordinals, 151);
      assert.equal(new Set(ordinals).size, 151);
      assert.isTrue(ordinals.every((ordinal) => ordinal > 1_000_000));
      assert.isTrue(
        ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]!),
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-many-items:update"),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...items[0]!, ordinal: 99_999_999, title: "Updated" },
          },
        ],
      });
      const afterUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterUpdate.turnItems[0]?.ordinal, ordinals[0]);
      assert.equal((yield* maintenance.verify).valid, true);

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = '{}'
        WHERE turn_item_id = ${items[75]!.id}
      `;
      const broken = yield* maintenance.verify;
      assert.isFalse(broken.valid);
      assert.deepEqual(broken.unreadableThreadIds, [threadId]);

      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);
      assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).turnItems, 151);
    }),
  );
});

it.live("keeps claiming new work after repeated idle periods", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutboxV2;
    const completed = new Map<string, Deferred.Deferred<void>>();
    const executorLayer = Layer.succeed(
      OrchestrationEffectExecutorV2,
      OrchestrationEffectExecutorV2.of({
        execute: (effect) => {
          const completion = completed.get(effect.id);
          return completion === undefined
            ? Effect.die(`Missing completion signal for ${effect.id}`)
            : Deferred.succeed(completion, undefined).pipe(Effect.asVoid);
        },
      }),
    );
    const workerLayer = effectWorkerLayerWithOptions({
      workerId: "idle-wave-worker",
    }).pipe(Layer.provide(Layer.merge(Layer.succeed(EffectOutboxV2, outbox), executorLayer)));

    yield* Effect.gen(function* () {
      yield* runEffectWorkerDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
      for (let wave = 1; wave <= 6; wave += 1) {
        yield* Effect.sleep("125 millis");
        const effectId = `effect:foundation-idle-wave:${wave}`;
        const completion = yield* Deferred.make<void>();
        completed.set(effectId, completion);
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId: CommandId.make(`command:foundation-idle-wave:${wave}`),
            threadId: ThreadId.make(`thread:foundation-idle-wave:${wave}`),
            request: { type: "terminal.cleanup" },
          },
        ]);
        yield* outbox.notifyAvailable();
        const observed = yield* Deferred.await(completion).pipe(Effect.timeoutOption("2 seconds"));
        assert.isTrue(Option.isSome(observed), `worker stopped before idle wave ${wave}`);
      }
    }).pipe(Effect.provide(workerLayer), Effect.scoped);
  }).pipe(Effect.provide(TestLayer)),
);
