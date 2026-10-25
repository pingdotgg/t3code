import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Turn item compaction",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreated(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return {
    id: EventId.make("event:turn-item-compaction:thread"),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  } satisfies OrchestrationV2DomainEvent;
}

const itemSpecs = [
  { key: "command", type: "command_execution", ordinal: 10 },
  { key: "reasoning", type: "reasoning", ordinal: 20 },
  { key: "todo", type: "todo_list", ordinal: 30 },
  { key: "commanded", type: "command_execution", ordinal: 40 },
] as const;

function itemEvent(
  threadId: ThreadId,
  now: DateTime.Utc,
  spec: (typeof itemSpecs)[number],
  revision: number,
  eventId = `event:turn-item-compaction:${spec.key}:${revision}`,
): OrchestrationV2DomainEvent {
  const id = TurnItemId.make(`turn-item:compaction:${spec.key}`);
  const growing = `${spec.key}:${revision}:` + "x".repeat((revision + 1) * 192);
  const completed = revision === 69;
  const base = {
    id,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: spec.ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: spec.key,
    startedAt: now,
    completedAt: completed ? now : null,
    updatedAt: now,
  };
  let payload: OrchestrationV2TurnItem;
  switch (spec.type) {
    case "command_execution":
      payload = {
        ...base,
        type: "command_execution",
        input: `run ${spec.key}`,
        output: growing,
      };
      break;
    case "reasoning":
      payload = { ...base, type: "reasoning", text: growing, streaming: !completed };
      break;
    case "todo_list":
      payload = {
        ...base,
        type: "todo_list",
        planId: PlanId.make("plan:turn-item-compaction"),
        steps: [{ id: "step", text: growing, status: completed ? "completed" : "running" }],
        explanation: growing,
      };
      break;
  }
  return {
    id: EventId.make(eventId),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  };
}

function subagentEvents(
  threadId: ThreadId,
  now: DateTime.Utc,
  revision: number,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = NodeId.make("subagent:turn-item-compaction");
  const prompt = revision === 0 ? "Review prompt A. ".repeat(40) : "Review prompt B. ".repeat(40);
  const progress = `Review progress ${revision}`;
  return [
    {
      id: EventId.make(`event:turn-item-compaction:subagent:${revision}`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:turn-item-compaction-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver: providerDriver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: {
          driver: providerDriver,
          nativeId: "compaction-review",
          strength: "strong",
        },
        prompt,
        progress,
        title: "Review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
    {
      id: EventId.make(`event:turn-item-compaction:subagent-item:${revision}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:compaction:subagent"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 50,
        status: "running",
        title: "Review",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: id,
        origin: "provider_native",
        driver: providerDriver,
        providerInstanceId,
        childThreadId: null,
        prompt,
        progress,
        result: null,
      },
    },
  ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
}

it.effect(
  "compacts ordinary snapshots while preserving replay, prompts, command lookup, and positions",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:turn-item-compaction");
      const thread = makeThread(threadId, now);
      const writes = [...(yield* sink.write({ events: [threadCreated(thread, now)] }))];
      const commandId = CommandId.make("command:turn-item-compaction:middle");
      const snapshotsPerItem = 70;
      for (let revision = 0; revision < snapshotsPerItem; revision += 1) {
        const order =
          revision === 0
            ? [itemSpecs[0], itemSpecs[1], itemSpecs[2], itemSpecs[3]]
            : [itemSpecs[1], itemSpecs[0], itemSpecs[2], itemSpecs[3]];
        const events = order
          .filter((spec) => spec.key !== "commanded" || revision !== 35)
          .map((spec) => itemEvent(threadId, now, spec, revision));
        if (revision < 3) events.push(...subagentEvents(threadId, now, revision));
        const stored = yield* sink.write({ events });
        writes.push(...stored);
        if (revision === 35) {
          const middle = itemEvent(
            threadId,
            now,
            itemSpecs[3],
            revision,
            "event:turn-item-compaction:commanded:middle",
          );
          writes.push(...(yield* sink.write({ commandId, events: [middle] })));
        }
      }
      const beforeProjection = yield* projections.getThreadProjection(threadId);
      const highWater = yield* eventStore.latestSequence();
      const bytes = yield* sql<{ readonly rows: number; readonly payload_bytes: number }>`
      SELECT COUNT(*) AS rows, COALESCE(SUM(octet_length(payload_json)), 0) AS payload_bytes
      FROM orchestration_events WHERE stream_id = ${threadId}
    `;
      const summary = yield* maintenance.compactEventStore();
      const replay = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      const expectedIds = new Set([
        "event:turn-item-compaction:thread",
        ...itemSpecs.flatMap((spec) => [
          `event:turn-item-compaction:${spec.key}:0`,
          `event:turn-item-compaction:${spec.key}:${snapshotsPerItem - 1}`,
        ]),
        "event:turn-item-compaction:commanded:middle",
        ...Array.from({ length: 3 }, (_, revision) => [
          `event:turn-item-compaction:subagent:${revision}`,
          `event:turn-item-compaction:subagent-item:${revision}`,
        ]).flat(),
      ]);
      assert.deepEqual(
        replay,
        writes.filter((stored) => expectedIds.has(stored.event.id)),
      );
      assert.lengthOf(replay, 16);
      assert.equal(summary.deletedEventCount, bytes[0]!.rows - replay.length);
      assert.isBelow(
        (yield* sql<{ readonly payload_bytes: number }>`
        SELECT COALESCE(SUM(octet_length(payload_json)), 0) AS payload_bytes
        FROM orchestration_events WHERE stream_id = ${threadId}
      `)[0]!.payload_bytes,
        bytes[0]!.payload_bytes,
      );
      assert.equal(yield* eventStore.latestSequence(), highWater);

      const commanded = yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.deepEqual(
        commanded.map((stored) => stored.event.id),
        [EventId.make("event:turn-item-compaction:commanded:middle")],
      );
      const storedPrompts = yield* sql<{
        readonly event_id: string;
        readonly sequence: number;
        readonly prompt: string;
        readonly prompt_sequence: number | null;
      }>`
      SELECT event_id, sequence,
        json_extract(payload_json, '$.prompt') AS prompt,
        json_extract(payload_json, '$.promptSequence') AS prompt_sequence
      FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type = 'subagent.updated'
      ORDER BY sequence ASC
    `;
      assert.lengthOf(storedPrompts, 3);
      assert.equal(storedPrompts[0]!.prompt_sequence, null);
      assert.equal(storedPrompts[1]!.prompt_sequence, null);
      assert.equal(storedPrompts[2]!.prompt, "");
      assert.equal(storedPrompts[2]!.prompt_sequence, storedPrompts[1]!.sequence);

      const deletedCursor = writes.find(
        (stored) => stored.event.id === "event:turn-item-compaction:command:35",
      )!.sequence;
      assert.isFalse(replay.some((stored) => stored.sequence === deletedCursor));
      const cursors = [0, deletedCursor, highWater];
      for (const cursor of cursors) {
        const cursorReplay = yield* eventStore
          .read({ threadId, afterSequence: cursor, throughSequence: highWater })
          .pipe(Stream.runCollect);
        const expected = replay.filter((stored) => stored.sequence > cursor);
        assert.deepEqual(
          cursorReplay.map((stored) => stored.sequence),
          expected.map((stored) => stored.sequence),
        );

        let clientProjection: typeof beforeProjection | null = {
          ...beforeProjection,
          subagents: [],
          turnItems: [],
          visibleTurnItems: [],
        };
        let latestLocalTurnOrdinal: number | null = null;
        for (const stored of [
          ...writes.filter((entry) => entry.sequence <= cursor),
          ...cursorReplay,
        ]) {
          clientProjection = applyOrchestrationV2ProjectionEvent(clientProjection, stored.event, {
            partialTimeline: true,
            latestLocalTurnOrdinal,
          });
          if (stored.event.type === "turn-item.updated") {
            latestLocalTurnOrdinal = Math.max(
              latestLocalTurnOrdinal ?? 0,
              stored.event.payload.ordinal,
            );
          }
        }
        assert.deepEqual(clientProjection?.turnItems, beforeProjection.turnItems);
        assert.deepEqual(clientProjection?.visibleTurnItems, beforeProjection.visibleTurnItems);
      }
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* projections.getThreadProjection(threadId), beforeProjection);
      const positions = yield* sql<{
        readonly turn_item_id: string;
        readonly ordinal: number;
      }>`
      SELECT turn_item_id, ordinal
      FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${threadId}
      ORDER BY ordinal ASC
    `;
      assert.deepEqual(
        positions.map((row) => [row.turn_item_id, row.ordinal]),
        [
          ...itemSpecs.map((spec, index) => [`turn-item:compaction:${spec.key}`, index + 1]),
          ["turn-item:compaction:subagent", 5],
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps post-bound appends visible during compaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:turn-item-compaction-race");
      const thread = makeThread(threadId, now);
      const initial = yield* sink.write({
        events: [
          threadCreated(thread, now),
          ...[0, 1, 2].map((revision) => itemEvent(threadId, now, itemSpecs[0], revision)),
        ],
      });
      const beforeSequence = initial.at(-1)!.sequence;

      const streamReady = yield* Deferred.make<void>();
      const streamTracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string" && query.includes("MAX(sequence)")) {
              Deferred.doneUnsafe(streamReady, Effect.void);
            }
          };
          return span;
        },
      });
      const liveEvents = yield* sink
        .stream({ threadId, afterSequence: beforeSequence })
        .pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.withTracer(streamTracer),
          Effect.forkScoped,
        );
      yield* Deferred.await(streamReady);

      const scanStarted = yield* Deferred.make<void>();
      const releaseScan = yield* Deferred.make<void>();
      let blocked = false;
      const blockFirstScanPage: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (
          !blocked &&
          query.includes("FROM orchestration_events AS event") &&
          query.includes("ORDER BY event.sequence DESC")
        ) {
          blocked = true;
          return Deferred.succeed(scanStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseScan)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const compaction = yield* maintenance
        .compactEventStore()
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, blockFirstScanPage),
          Effect.forkScoped,
        );
      yield* Deferred.await(scanStarted);
      const snapshots = [3, 4, 5].map((revision) =>
        itemEvent(
          threadId,
          now,
          itemSpecs[0],
          revision,
          `event:turn-item-compaction-race:${revision}`,
        ),
      );
      const appended = yield* sink.write({ events: snapshots });
      yield* Deferred.succeed(releaseScan, undefined);
      assert.equal((yield* Fiber.join(compaction)).deletedEventCount, 1);
      const streamed = yield* Fiber.join(liveEvents);
      assert.deepEqual(
        streamed.map((stored) => stored.sequence),
        appended.map((stored) => stored.sequence),
      );
      assert.deepEqual(
        streamed.map((stored) => stored.event.id),
        snapshots.map((event) => event.id),
      );
      assert.equal(yield* eventStore.latestSequence(), appended.at(-1)!.sequence);
      const firstPassRows = yield* eventStore
        .read({ threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        firstPassRows.map((stored) => stored.sequence),
        [initial[1]!.sequence, beforeSequence, ...appended.map((stored) => stored.sequence)],
      );
      yield* maintenance.compactEventStore();
      const secondPassRows = yield* eventStore
        .read({ threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        secondPassRows.map((stored) => stored.sequence),
        [initial[1]!.sequence, appended.at(-1)!.sequence],
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);
