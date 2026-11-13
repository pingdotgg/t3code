// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins

import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
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
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ServerSettings from "../serverSettings.ts";
import { LIVE_STREAM_MAX_ITEMS, LiveStreamBufferError } from "./LiveStreamBudget.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

import {
  encodeJson,
  isLiveStreamBufferError,
  layerCommandReceiptStoreProvided,
  layerDatabase,
  layerEffectOutboxProvided,
  layerEventSinkProvided,
  layerEventStoreProvided,
  layerIsolatedOutbox,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
  layerProjectionStoreProvided,
  layerStoresProvided,
  layerTest,
  makeThread,
  modelSelection,
  providerDriver,
  providerInstanceId,
  seedCompaction,
  threadCreatedEvent,
} from "./FoundationPersistence-fixtures.testkit.ts";

it.layer(layerTest)("orchestration V2 foundation persistence", (it) => {
  it.effect("projects oversized tool bodies before both replay and live RPC retention", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* EventStore.EventStoreV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const thread = makeThread(ThreadId.make("thread:large-stream-body"), now);
        const output = {
          content: [{ type: "text", text: "first line\n" + "x".repeat(9 * 1024 * 1024) }],
        };
        const tool: OrchestrationV2TurnItem = {
          id: TurnItemId.make("tool:large-stream-body"),
          type: "dynamic_tool",
          threadId: thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "Large tool",
          toolName: "mcp__large_tool",
          input: { query: "details" },
          output,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const [created] = yield* sink.write({
          events: [
            threadCreatedEvent({ id: "event:large-stream-body:created", thread, now }),
            {
              id: EventId.make("event:large-stream-body:replay"),
              type: "turn-item.updated",
              threadId: thread.id,
              occurredAt: now,
              payload: tool,
            },
          ],
        });
        const pull = yield* Stream.toPull(
          sink.stream({
            threadId: thread.id,
            afterSequence: created!.sequence,
            bounded: true,
          }),
        );
        const replay = yield* pull;
        assert.lengthOf(replay, 1);
        assert.equal(replay[0]!.event.type, "turn-item.updated");
        assert.isBelow(Buffer.byteLength(yield* encodeJson(replay)), 4_000);
        const [completed] = yield* sink.write({
          events: [
            {
              id: EventId.make("event:large-stream-body:live"),
              type: "turn-item.updated",
              threadId: thread.id,
              occurredAt: now,
              payload: { ...tool, status: "completed", completedAt: now },
            },
          ],
        });
        const live = yield* pull;
        assert.deepEqual(
          live.map((stored) => stored.sequence),
          [completed!.sequence],
        );
        assert.isBelow(Buffer.byteLength(yield* encodeJson(live)), 4_000);
        for (const stored of [...replay, ...live]) {
          assert.equal(stored.event.type, "turn-item.updated");
          if (stored.event.type !== "turn-item.updated") return;
          assert.equal(stored.event.payload.type, "dynamic_tool");
          if (stored.event.payload.type !== "dynamic_tool") return;
          assert.notProperty(stored.event.payload, "output");
        }
        const persisted = yield* store.read({ threadId: thread.id }).pipe(Stream.runCollect);
        const fullEvent = persisted.find(
          (stored) => stored.sequence === completed!.sequence,
        )!.event;
        assert.equal(fullEvent.type, "turn-item.updated");
        if (fullEvent.type !== "turn-item.updated") return;
        assert.equal(fullEvent.payload.type, "dynamic_tool");
        if (fullEvent.payload.type !== "dynamic_tool") return;
        assert.deepEqual(fullEvent.payload.output, output);
        const detail = (yield* projections.getThreadProjection(thread.id)).turnItems.find(
          (item) => item.id === tool.id,
        )!;
        assert.equal(detail.type, "dynamic_tool");
        if (detail.type === "dynamic_tool") assert.deepEqual(detail.output, output);
      }),
    ),
  );

  it.effect.each(["high-water", "replay"] as const)(
    "bounds live events while the V2 %s query is blocked",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const thread = makeThread(ThreadId.make(`thread:blocked-${phase}`), now);
          const [created] = yield* sink.write({
            events: [threadCreatedEvent({ id: `event:blocked-${phase}:created`, thread, now })],
          });
          const readStarted = yield* Deferred.make<void>();
          const readClosed = yield* Deferred.make<void>();
          const blockRead: Statement.Transformer = (statement) => {
            const [query] = statement.compile();
            if (
              query.includes("FROM orchestration_events") &&
              query.includes("MAX(sequence)") === (phase === "high-water")
            ) {
              return Deferred.succeed(readStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(readClosed, undefined)),
                Effect.as(statement),
              );
            }
            return Effect.succeed(statement);
          };
          const reader = yield* sink
            .stream({ threadId: thread.id, afterSequence: created!.sequence, bounded: true })
            .pipe(
              Stream.provideService(Statement.CurrentTransformer, blockRead),
              Stream.runDrain,
              Effect.result,
              Effect.forkScoped,
            );
          yield* Deferred.await(readStarted);
          yield* sink.write({
            events: Array.from({ length: LIVE_STREAM_MAX_ITEMS + 1 }, (_, index) => ({
              id: EventId.make(`event:blocked-${phase}:${index}`),
              type: "thread.metadata-updated" as const,
              threadId: thread.id,
              occurredAt: now,
              payload: { ...thread, title: `Updated ${index}` },
            })),
          });
          yield* Deferred.await(readClosed);
          const result = yield* Fiber.join(reader);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure._tag, "EventSinkStreamError");
            assert.isTrue(isLiveStreamBufferError(result.failure.cause));
          }
        }),
      ),
  );

  it.effect(
    "keeps internal streams subscribed while replay is blocked beyond the RPC buffer cap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const thread = makeThread(ThreadId.make("thread:internal-stream-burst"), now);
          const [created] = yield* sink.write({
            events: [
              threadCreatedEvent({ id: "event:internal-stream-burst:created", thread, now }),
            ],
          });
          const readStarted = yield* Deferred.make<void>();
          const releaseRead = yield* Deferred.make<void>();
          const blockHighWater: Statement.Transformer = (statement) => {
            const [query] = statement.compile();
            return query.includes("MAX(sequence)") && query.includes("FROM orchestration_events")
              ? Deferred.succeed(readStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRead)),
                  Effect.as(statement),
                )
              : Effect.succeed(statement);
          };
          const eventCount = LIVE_STREAM_MAX_ITEMS + 1;
          const reader = yield* sink
            .stream({ threadId: thread.id, afterSequence: created!.sequence })
            .pipe(
              Stream.provideService(Statement.CurrentTransformer, blockHighWater),
              Stream.take(eventCount),
              Stream.runCollect,
              Effect.forkScoped,
            );
          yield* Deferred.await(readStarted);
          const written = yield* sink.write({
            events: Array.from({ length: eventCount }, (_, index) => ({
              id: EventId.make(`event:internal-stream-burst:${index}`),
              type: "thread.metadata-updated" as const,
              threadId: thread.id,
              occurredAt: now,
              payload: { ...thread, title: `Updated ${index}` },
            })),
          });
          yield* Deferred.succeed(releaseRead, undefined);
          assert.deepEqual(
            (yield* Fiber.join(reader)).map((event) => event.sequence),
            written.map((event) => event.sequence),
          );
        }),
      ),
  );

  it.effect("filters worker replay and live queues without losing matching events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const thread = makeThread(ThreadId.make("thread:filtered-worker"), now);
        const other = makeThread(ThreadId.make("thread:filtered-worker-other"), now);
        const run: OrchestrationV2Run = {
          id: RunId.make("run:filtered-worker"),
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:filtered-worker"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        };
        const runEvent = (id: string, payload: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
          id: EventId.make(id),
          type: "run.updated",
          threadId: payload.threadId,
          runId: payload.id,
          occurredAt: now,
          payload,
        });
        const history = yield* sink.write({
          events: [
            threadCreatedEvent({ id: "event:filtered-worker:created", thread, now }),
            threadCreatedEvent({ id: "event:filtered-worker:other", thread: other, now }),
            runEvent("event:filtered-worker:history", run),
            runEvent("event:filtered-worker:other-history", {
              ...run,
              id: RunId.make("run:filtered-worker-other"),
              threadId: other.id,
            }),
          ],
        });
        const original = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events
          WHERE sequence = ${history[0]!.sequence}
        `;
        yield* Effect.acquireRelease(
          sql`
            UPDATE orchestration_events SET payload_json = 'unreadable unrelated payload'
            WHERE sequence = ${history[0]!.sequence}
          `,
          () =>
            sql`
              UPDATE orchestration_events SET payload_json = ${original[0]!.payload_json}
              WHERE sequence = ${history[0]!.sequence}
            `.pipe(Effect.orDie),
        );
        const pull = yield* Stream.toPull(
          sink.stream({ threadId: thread.id, eventType: "run.updated" }),
        );
        assert.deepEqual(
          (yield* pull).map((stored) => stored.sequence),
          [history[2]!.sequence],
        );
        yield* sink.write({
          events: Array.from({ length: LIVE_STREAM_MAX_ITEMS + 1 }, (_, index) => ({
            id: EventId.make(`event:filtered-worker:output:${index}`),
            type: "thread.metadata-updated" as const,
            threadId: thread.id,
            occurredAt: now,
            payload: { ...thread, title: `Output ${index}` },
          })),
        });
        const live = yield* sink.write({
          events: [
            runEvent("event:filtered-worker:live:1", { ...run, status: "interrupted" }),
            runEvent("event:filtered-worker:live:2", { ...run, status: "failed" }),
          ],
        });
        assert.deepEqual(
          (yield* pull).map((stored) => stored.sequence),
          live.map((stored) => stored.sequence),
        );
      }),
    ),
  );

  it.effect("paginates catch-up beyond the event-store read limit", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
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
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stream-race");
      const thread = makeThread(threadId, now);
      const created = yield* eventSink.write({
        events: [threadCreatedEvent({ id: "event:foundation-stream-race:0", thread, now })],
      });

      let afterSequence = created[0]!.sequence;
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- Fixed-count writes exercise the catch-up/live handoff; each iteration awaits its event rather than polling.
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
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
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

  it.effect("prunes covered history, imported v1 events, and legacy receipts", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:foundation-compact");
      const thread = makeThread(threadId, now);
      const messageId = MessageId.make("message:foundation-compact");
      const threadStateEvent = (
        suffix: string,
        type: "thread.visited" | "thread.metadata-updated" | "thread.tags-updated",
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
      const nodeId = NodeId.make("node:foundation-compact");
      const nodeEvent = (
        suffix: string,
        status: "running" | "completed",
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "assistant_message",
          status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      });
      const itemEvent = (suffix: string, text: string): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:foundation-compact"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId,
          text,
          streaming: false,
        },
      });

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-compact:create", thread, now }),
          threadStateEvent("meta", "thread.metadata-updated"),
          threadStateEvent("visit-1", "thread.visited"),
          messageEvent("message-1", "streaming"),
          nodeEvent("node-1", "running"),
          itemEvent("item-1", "streaming"),
          itemEvent("item-middle", "still streaming"),
          ...Array.from({ length: 501 }, (_, index) =>
            threadStateEvent(`history-${index}`, "thread.visited"),
          ),
          threadStateEvent("tags-1", "thread.tags-updated"),
          threadStateEvent("visit-2", "thread.visited"),
          messageEvent("message-2", "final"),
          nodeEvent("node-2", "completed"),
          itemEvent("item-2", "final"),
          // Older clients skip tag events, so these must not remove the rename above.
          threadStateEvent("tags-2", "thread.tags-updated"),
        ],
      });
      const beforeCompaction = yield* projections.getThreadProjection(threadId);

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

      // The first pass only marks the head and drops imported legacy rows.
      const marked = yield* maintenance.pruneEventStore();
      yield* TestClock.adjust("1 day");
      const summary = yield* maintenance.pruneEventStore();
      assert.isAtLeast(summary.deletedEventCount, 504);
      assert.equal(marked.deletedReceiptCount + summary.deletedReceiptCount, 1);

      const remaining = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
        ORDER BY sequence ASC
      `;
      assert.deepEqual(
        remaining.map((row) => row.event_id),
        ["event:foundation-compact:create", "event:foundation-compact:tags-2"],
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

      assert.deepEqual(yield* projections.getThreadProjection(threadId), beforeCompaction);
    }),
  );
});
