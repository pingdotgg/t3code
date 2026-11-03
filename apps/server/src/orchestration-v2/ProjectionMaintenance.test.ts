import { assert, it } from "@effect/vitest";
import {
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
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  OrchestrationEventStore.layer.pipe(Layer.provide(database)),
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
  eventSuffix = String(revision),
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = NodeId.make("subagent:turn-item-compaction");
  const prompt = revision === 0 ? "Review prompt A. ".repeat(40) : "Review prompt B. ".repeat(40);
  const progress = `Review progress ${revision}`;
  return [
    {
      id: EventId.make(`event:turn-item-compaction:subagent:${eventSuffix}`),
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
      id: EventId.make(`event:turn-item-compaction:subagent-item:${eventSuffix}`),
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

const insertRunningRunUpdate = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'event:prune:run-running', 'thread', ${threadId},
        (SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE stream_id = ${threadId}),
        'run.updated', '2026-11-01T00:00:00.000Z', 'server', '{"status":"running"}', '{}', 2
      ) RETURNING sequence
    `,
  );

const remainingEventIds = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
    `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.event_id)));

it.effect("prunes events the projections cover once the retained day has passed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    for (const revision of [0, 1, 2]) {
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], revision)] });
    }
    yield* sink.write({ events: subagentEvents(threadId, now, 0) });
    yield* insertRunningRunUpdate(threadId);
    yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[1], 0)] });

    // The first pass only marks the head; nothing is a day old yet.
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    const markedThrough = yield* eventStore.latestSequence();

    // Repeating prompt A borrows it from the anchors written before the mark.
    yield* sink.write({ events: subagentEvents(threadId, now, 0, "repeat") });
    yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], 3)] });
    const highWater = yield* eventStore.latestSequence();
    const projection = yield* projections.getThreadProjection(threadId);

    yield* TestClock.adjust("23 hours");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    yield* TestClock.adjust("1 hour");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 4);

    assert.deepEqual(yield* remainingEventIds(threadId), [
      "event:turn-item-compaction:thread",
      "event:turn-item-compaction:subagent:0",
      "event:turn-item-compaction:subagent-item:0",
      "event:prune:run-running",
      "event:turn-item-compaction:subagent:repeat",
      "event:turn-item-compaction:subagent-item:repeat",
      "event:turn-item-compaction:command:3",
    ]);
    assert.equal(yield* events.prunedThroughSequence, markedThrough);
    assert.equal(yield* eventStore.latestSequence(), highWater);
    assert.equal(yield* eventStore.latestSequence({ threadId }), highWater);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), projection);
    const repeated = yield* eventStore
      .read({ threadId, eventType: "subagent.updated", afterSequence: markedThrough })
      .pipe(Stream.runCollect);
    assert.deepEqual(
      Array.from(repeated, (stored) =>
        stored.event.type === "subagent.updated" ? stored.event.payload.prompt : null,
      ),
      ["Review prompt A. ".repeat(40)],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the anchor a retained stream head borrows from", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-head");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: subagentEvents(threadId, now, 0) });
    // The stream's newest row borrows prompt A, so it is kept below the boundary.
    yield* sink.write({ events: subagentEvents(threadId, now, 0, "repeat") });
    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");
    assert.isAbove((yield* maintenance.pruneEventStore()).deletedEventCount, 0);

    assert.include(
      yield* remainingEventIds(threadId),
      "event:turn-item-compaction:subagent-item:0",
    );
    const stored = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
    const head = Array.from(stored).at(-1)?.event;
    assert.deepEqual(
      head?.type === "turn-item.updated" && head.payload.type === "subagent"
        ? head.payload.prompt
        : null,
      "Review prompt A. ".repeat(40),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps an anchor that a row appended during the pass borrows from", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:prune-race");
      yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
      yield* sink.write({ events: subagentEvents(threadId, now, 0) });
      yield* maintenance.pruneEventStore();
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], 0)] });
      yield* TestClock.adjust("1 day");

      const scanStarted = yield* Deferred.make<void>();
      const releaseScan = yield* Deferred.make<void>();
      let blocked = false;
      const blockFirstScanPage: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (!blocked && query.includes("END AS prunable")) {
          blocked = true;
          return Deferred.succeed(scanStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseScan)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const pass = yield* maintenance
        .pruneEventStore()
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, blockFirstScanPage),
          Effect.forkScoped,
        );
      yield* Deferred.await(scanStarted);
      yield* sink.write({ events: subagentEvents(threadId, now, 0, "late") });
      yield* Deferred.succeed(releaseScan, undefined);
      assert.equal((yield* Fiber.join(pass)).deletedEventCount, 0);

      const late = yield* eventStore
        .read({ threadId, eventType: "subagent.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        Array.from(late, (stored) =>
          stored.event.type === "subagent.updated" ? stored.event.payload.prompt : null,
        ),
        ["Review prompt A. ".repeat(40), "Review prompt A. ".repeat(40)],
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);
