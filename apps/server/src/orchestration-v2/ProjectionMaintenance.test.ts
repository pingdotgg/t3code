import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
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

function messageUpdated(threadId: ThreadId, now: DateTime.Utc, text: string) {
  return {
    id: EventId.make(`event:purge:${threadId}:message`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(`message:${threadId}`),
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
  } satisfies OrchestrationV2DomainEvent;
}

const writeThread = (thread: OrchestrationV2AppThread, now: DateTime.Utc) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    Effect.gen(function* () {
      yield* sink.write({
        events: [{ ...threadCreated(thread, now), id: EventId.make(`event:purge:${thread.id}`) }],
      });
      yield* sink.write({ events: [messageUpdated(thread.id, now, `secret in ${thread.id}`)] });
      yield* sink.write({
        events: [itemEvent(thread.id, now, itemSpecs[0], 0, `event:purge:${thread.id}:item`)],
      });
    }),
  );

const deleteThread = (thread: OrchestrationV2AppThread, now: DateTime.Utc) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.write({
      events: [
        {
          id: EventId.make(`event:purge:${thread.id}:deleted`),
          type: "thread.deleted",
          threadId: thread.id,
          providerInstanceId,
          occurredAt: now,
          payload: { ...thread, deletedAt: now, updatedAt: now },
        },
      ],
    }),
  );

const contentRowCount = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(ProjectionMaintenance.DELETED_THREAD_CONTENT_TABLES, (table) =>
      sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    ),
  ).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)));

const searchMatches = (text: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_message_search
      WHERE orchestration_v2_message_search MATCH ${`"${text}"`}
    `,
  ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

it.effect("a deleted thread keeps only its tombstone", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const deleted = makeThread(ThreadId.make("thread:purge-deleted"), now);
    const live = makeThread(ThreadId.make("thread:purge-live"), now);
    yield* writeThread(deleted, now);
    yield* writeThread(live, now);
    const liveProjection = yield* projections.getThreadProjection(live.id);
    assert.equal(yield* searchMatches("secret in thread:purge-deleted"), 1);

    yield* deleteThread(deleted, now);
    assert.isAbove(yield* maintenance.purgeDeletedThread(deleted.id), 0);

    assert.equal(yield* contentRowCount(deleted.id), 0);
    assert.equal(yield* searchMatches("secret in thread:purge-deleted"), 0);
    assert.deepEqual(yield* remainingEventIds(deleted.id), [
      "event:purge:thread:purge-deleted",
      "event:purge:thread:purge-deleted:deleted",
    ]);
    const tombstone = yield* Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly deleted_at: string | null; readonly title: string }>`
        SELECT deleted_at, title FROM orchestration_v2_projection_threads
        WHERE thread_id = ${deleted.id}
      `,
    );
    assert.isNotNull(tombstone[0]?.deleted_at ?? null);
    assert.equal(tombstone[0]?.title, ProjectionMaintenance.DELETED_THREAD_TITLE);
    const leaked = yield* Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_events
            WHERE stream_id = ${deleted.id} AND payload_json LIKE ${`%${deleted.title}%`})
          + (SELECT COUNT(*) FROM orchestration_v2_projection_threads
            WHERE thread_id = ${deleted.id} AND payload_json LIKE ${`%${deleted.title}%`})
          AS count
      `,
    );
    assert.equal(leaked[0]?.count, 0);
    assert.deepEqual(yield* projections.getThreadProjection(live.id), liveProjection);
    assert.equal(yield* maintenance.purgeDeletedThread(deleted.id), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a deleted run-fork source stays until its last live fork is deleted", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const source = makeThread(ThreadId.make("thread:purge-source"), now);
    const fork: OrchestrationV2AppThread = {
      ...makeThread(ThreadId.make("thread:purge-fork"), now),
      forkedFrom: { type: "run", threadId: source.id, runId: RunId.make("run:purge-source") },
    };
    yield* writeThread(source, now);
    yield* writeThread(fork, now);

    yield* deleteThread(source, now);
    assert.equal(yield* maintenance.purgeDeletedThread(source.id), 0);
    assert.isAbove(yield* contentRowCount(source.id), 0);

    yield* deleteThread(fork, now);
    yield* maintenance.purgeDeletedThread(fork.id);
    assert.equal(yield* contentRowCount(source.id), 0);
    assert.equal(yield* contentRowCount(fork.id), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the maintenance pass purges threads deleted before purging existed", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const deleted = makeThread(ThreadId.make("thread:purge-backfill"), now);
    // Renamed to the placeholder before deletion; its first title is still on record.
    const renamed = makeThread(ThreadId.make("thread:purge-renamed"), now);
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.write({
        events: [{ ...threadCreated(renamed, now), id: EventId.make("event:purge:renamed") }],
      }),
    );
    yield* deleteThread({ ...renamed, title: ProjectionMaintenance.DELETED_THREAD_TITLE }, now);
    yield* writeThread(deleted, now);
    yield* deleteThread(deleted, now);
    // A late transcript import leaves a content event as the stream head.
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [itemEvent(deleted.id, now, itemSpecs[1], 0, "event:purge:late-item")],
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at
      ) VALUES (
        'effect:purge-backfill', 'command:purge-backfill', ${deleted.id}, 'terminal.cleanup',
        '{"type":"terminal.cleanup"}', 'pending', '2026-11-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
      )
    `;

    // An earlier effect still reads the thread, so the pass waits for it.
    yield* maintenance.pruneEventStore();
    assert.isAbove(yield* contentRowCount(deleted.id), 0);
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;

    assert.isAbove((yield* maintenance.pruneEventStore()).purgedRowCount, 0);
    assert.equal(yield* contentRowCount(deleted.id), 0);
    assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);
    const stream = yield* EventStore.EventStoreV2.pipe(
      Effect.flatMap((store) => store.read({ threadId: deleted.id }).pipe(Stream.runCollect)),
    );
    assert.deepEqual(
      Array.from(stream, (stored) => stored.event.type),
      ["thread.created", "thread.deleted", "thread.deleted"],
    );
    const leaked = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE stream_id = ${deleted.id}
        AND (payload_json LIKE '%reasoning:0%' OR payload_json LIKE ${`%${deleted.title}%`})
    `;
    assert.equal(leaked[0]?.count, 0);
    const renamedLeaks = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE stream_id = ${renamed.id} AND payload_json LIKE ${`%${renamed.title}%`}
    `;
    assert.equal(renamedLeaks[0]?.count, 0);
    assert.equal((yield* maintenance.pruneEventStore()).purgedRowCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a deleted thread's leftover settled request is purged", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const thread = {
      ...makeThread(ThreadId.make("thread:purge-placeholder"), now),
      title: ProjectionMaintenance.DELETED_THREAD_TITLE,
    };
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.write({
        events: [{ ...threadCreated(thread, now), id: EventId.make("event:purge:placeholder") }],
      }),
    );
    // A rename in between left its private title in a settled request.
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at
      ) VALUES (
        'effect:purge-placeholder', 'command:purge-placeholder', ${thread.id},
        'provider-session.apply-thread-title',
        '{"type":"provider-session.apply-thread-title","title":"private rename"}', 'succeeded',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
      )
    `;
    yield* deleteThread(thread, now);

    // The sweep alone finds the leftover request too.
    yield* maintenance.pruneEventStore();
    assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);

    // A pass interrupted after the content rows went still leaves a content event.
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.write({ events: [itemEvent(thread.id, now, itemSpecs[0], 0, "event:purge:stray")] }),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread.id}`;
    yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${thread.id}`;
    yield* maintenance.pruneEventStore();
    // It is the stream head, so its row stays as the tombstone.
    assert.deepEqual(
      yield* sql`SELECT event_type FROM orchestration_events WHERE event_id = 'event:purge:stray'`,
      [{ event_type: "thread.deleted" }],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an interrupted purge leaves a stream that still decodes", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const thread = makeThread(ThreadId.make("thread:purge-interrupted"), now);
    yield* sink.write({ events: [{ ...threadCreated(thread, now), id: EventId.make("event:i") }] });
    yield* sink.write({ events: subagentEvents(thread.id, now, 0, "anchor") });
    yield* deleteThread(thread, now);
    // A late update borrows the anchor's prompt and becomes the stream head.
    yield* sink.write({ events: subagentEvents(thread.id, now, 0, "borrower") });

    const failAfterEvents: Statement.Transformer = (statement) =>
      statement.compile()[0].includes("DELETE FROM orchestration_v2_effect_outbox")
        ? Effect.die("interrupted")
        : Effect.succeed(statement);
    const exit = yield* maintenance
      .purgeDeletedThread(thread.id)
      .pipe(Effect.provideService(Statement.CurrentTransformer, failAfterEvents), Effect.exit);
    assert.isTrue(exit._tag === "Failure");

    const stream = yield* eventStore.read({ threadId: thread.id }).pipe(Stream.runCollect);
    assert.equal(Array.from(stream).at(-1)?.event.type, "thread.deleted");
  }).pipe(Effect.provide(layerTest)),
);
