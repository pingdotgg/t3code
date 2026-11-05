import { assert, it } from "@effect/vitest";
import {
  ContextHandoffId,
  EventId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { renderHistory, selectHistory } from "@t3tools/provider-core/server/handoffBudget";
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

type HandoffItem = Extract<OrchestrationV2TurnItem, { readonly type: "handoff" }>;

function legacyHandoff(
  threadId: ThreadId,
  now: DateTime.Utc,
  key: string,
  strategy: OrchestrationV2ContextHandoff["strategy"] = "full_thread_summary",
) {
  const sourceProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:source`);
  const targetProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:target`);
  const messages: ReadonlyArray<OrchestrationV2HistoricalMessage> = [
    {
      role: "user",
      text: 'Inspect the tool result without changing "original" history.',
      threadId,
      runId: RunId.make(`run:${key}:source`),
      itemId: TurnItemId.make(`item:${key}:request`),
      providerThreadId: sourceProviderThreadId,
      status: "completed",
      kind: "user_message",
    },
    {
      role: "assistant",
      text: "Tool output α🙂\n".repeat(256),
      threadId,
      runId: RunId.make(`run:${key}:source`),
      runStatus: "completed",
      itemId: TurnItemId.make(`item:${key}:result`),
      providerThreadId: sourceProviderThreadId,
      status: "completed",
      kind: "command_execution",
    },
  ];
  const coverage = `Provider context handoff. Thread: ${threadId}. Covered app runs: 1-2.`;
  const selected = selectHistory({ messages, coverage, budget: 32_000 });
  const summary = renderHistory(selected.messages, selected.context);
  const handoff: OrchestrationV2ContextHandoff = {
    id: ContextHandoffId.make(`handoff:${key}`),
    threadId,
    targetRunId: RunId.make(`run:${key}:target`),
    fromProviderThreadIds: [sourceProviderThreadId],
    toProviderThreadId: targetProviderThreadId,
    coveredRunOrdinals: { from: 1, to: 2 },
    strategy,
    status: "ready",
    summaryMessageId: null,
    summaryText: summary,
    history: {
      messages: selected.messages,
      coverage,
      omittedItems: selected.omittedItems,
      omittedItemIds: selected.omittedItemIds,
    },
    createdByProviderInstanceId: providerInstanceId,
    createdAt: now,
    updatedAt: now,
  };
  const item: HandoffItem = {
    id: TurnItemId.make(`item:${key}:handoff`),
    threadId,
    runId: handoff.targetRunId,
    nodeId: null,
    providerThreadId: targetProviderThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Provider context handoff",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "handoff",
    contextHandoffId: handoff.id,
    fromProviderThreadIds: handoff.fromProviderThreadIds,
    toProviderThreadId: targetProviderThreadId,
    fromProviderInstanceIds: [providerInstanceId],
    toProviderInstanceId: providerInstanceId,
    strategy,
    summary,
  };
  return { handoff, item, receipt: selected.context };
}

function handoffEvent(handoff: OrchestrationV2ContextHandoff, eventId = `event:${handoff.id}`) {
  return {
    id: EventId.make(eventId),
    type: "context-handoff.updated",
    threadId: handoff.threadId,
    occurredAt: handoff.updatedAt,
    payload: handoff,
  } satisfies OrchestrationV2DomainEvent;
}

function handoffItemEvent(item: HandoffItem, eventId = `event:${item.id}`) {
  return {
    id: EventId.make(eventId),
    type: "turn-item.updated",
    threadId: item.threadId,
    occurredAt: item.updatedAt,
    payload: item,
  } satisfies OrchestrationV2DomainEvent;
}

const handoffRows = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly source: string;
      readonly id: string;
      readonly payload_json: string;
      readonly summary: string;
      readonly history: string | null;
    }>`
      SELECT 'context' AS source, context_handoff_id AS id, payload_json,
        json_extract(payload_json, '$.summaryText') AS summary,
        json_extract(payload_json, '$.history') AS history
      FROM orchestration_v2_projection_context_handoffs
      WHERE thread_id IN ${sql.in(threadIds)}
      UNION ALL
      SELECT 'activity', turn_item_id, payload_json,
        json_extract(payload_json, '$.summary'), NULL
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id IN ${sql.in(threadIds)}
      ORDER BY source, id
    `,
  );

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

it.effect.each([2, 60])("rewrites %s legacy handoffs whose events were pruned", (count) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:handoff-receipts");
    const fixtures = Array.from({ length: count }, (_, index) =>
      legacyHandoff(
        threadId,
        now,
        String(index),
        index % 2 === 0 ? "full_thread_summary" : "delta_since_target_last_seen",
      ),
    );
    yield* sink.write({
      events: [
        threadCreated(makeThread(threadId, now), now),
        ...fixtures.flatMap(({ handoff, item }) => [handoffEvent(handoff), handoffItemEvent(item)]),
      ],
    });
    yield* sql`DELETE FROM orchestration_events WHERE event_type != 'thread.created'`;
    const before = yield* handoffRows([threadId]);

    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);

    const after = yield* handoffRows([threadId]);
    assert.lengthOf(after, count * 2);
    assert.isTrue(after.every((row) => fixtures.some(({ receipt }) => row.summary === receipt)));
    assert.deepEqual(
      after.map(({ source, id, history }) => ({ source, id, history })),
      before.map(({ source, id, history }) => ({ source, id, history })),
    );
    assert.isBelow(
      after.reduce((size, row) => size + Buffer.byteLength(row.payload_json), 0),
      before.reduce((size, row) => size + Buffer.byteLength(row.payload_json), 0) / 2,
    );
    const projection = yield* projections.getThreadProjection(threadId);
    yield* maintenance.pruneEventStore();
    assert.deepEqual(yield* handoffRows([threadId]), after);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), projection);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps custom, unprovable, and non-provider handoff summaries intact", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:handoff-receipt-skips");
    const manual = legacyHandoff(threadId, now, "manual", "manual_context");
    const fork = legacyHandoff(threadId, now, "fork", "fork_delta_summary");
    const checkpoint = legacyHandoff(threadId, now, "checkpoint", "checkpoint_summary");
    const missing = legacyHandoff(threadId, now, "missing-history");
    const missingHandoff = { ...missing.handoff };
    delete missingHandoff.history;
    const empty = legacyHandoff(threadId, now, "empty-history");
    const custom = legacyHandoff(threadId, now, "custom-summary");
    const changed = legacyHandoff(threadId, now, "changed-history");
    const target = legacyHandoff(threadId, now, "different-target");
    const strategy = legacyHandoff(threadId, now, "different-strategy");
    const orphan = legacyHandoff(threadId, now, "missing-handoff");
    const foreignThreadId = ThreadId.make("thread:handoff-receipt-foreign");
    const foreign = legacyHandoff(foreignThreadId, now, "foreign-handoff");
    const fixtures = [
      manual,
      fork,
      checkpoint,
      { ...missing, handoff: missingHandoff },
      {
        ...empty,
        handoff: { ...empty.handoff, history: { ...empty.handoff.history!, messages: [] } },
      },
      {
        ...custom,
        handoff: {
          ...custom.handoff,
          summaryText: `Custom introduction\n${custom.handoff.summaryText}`,
        },
        item: { ...custom.item, summary: `Custom introduction\n${custom.item.summary}` },
      },
      {
        ...changed,
        handoff: {
          ...changed.handoff,
          history: {
            ...changed.handoff.history!,
            messages: changed.handoff.history!.messages.map((message) => ({
              ...message,
              text: `${message.text} changed`,
            })),
          },
        },
      },
      {
        ...target,
        handoff: { ...target.handoff, summaryText: target.receipt },
        item: {
          ...target.item,
          toProviderThreadId: ProviderThreadId.make("provider-thread:other"),
        },
      },
      {
        ...strategy,
        handoff: { ...strategy.handoff, summaryText: strategy.receipt },
        item: { ...strategy.item, strategy: "delta_since_target_last_seen" as const },
      },
      {
        ...foreign,
        handoff: { ...foreign.handoff, summaryText: foreign.receipt },
        item: { ...foreign.item, threadId },
      },
    ];
    yield* sink.write({
      events: [
        threadCreated(makeThread(threadId, now), now),
        {
          ...threadCreated(makeThread(foreignThreadId, now), now),
          id: EventId.make("event:handoff-receipt-foreign:thread"),
        },
        ...fixtures.flatMap(({ handoff, item }) => [handoffEvent(handoff), handoffItemEvent(item)]),
        handoffItemEvent(orphan.item),
      ],
    });
    const before = yield* handoffRows([threadId, foreignThreadId]);
    yield* maintenance.pruneEventStore();
    assert.deepEqual(yield* handoffRows([threadId, foreignThreadId]), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a handoff alone when a turn rewrites it during the pass", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:handoff-receipt-race");
      const fixture = legacyHandoff(threadId, now, "race");
      yield* sink.write({
        events: [
          threadCreated(makeThread(threadId, now), now),
          handoffEvent(fixture.handoff),
          handoffItemEvent(fixture.item),
        ],
      });

      const pageRead = yield* Deferred.make<void>();
      const releasePage = yield* Deferred.make<void>();
      const blockItemRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        return /^\s*SELECT payload_json FROM orchestration_v2_projection_turn_items/.test(query)
          ? Deferred.succeed(pageRead, undefined).pipe(
              Effect.andThen(Deferred.await(releasePage)),
              Effect.as(statement),
            )
          : Effect.succeed(statement);
      };
      const pass = yield* maintenance
        .pruneEventStore()
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, blockItemRead),
          Effect.forkScoped,
        );
      yield* Deferred.await(pageRead);
      yield* sink.write({
        events: [
          handoffEvent(
            {
              ...fixture.handoff,
              summaryText: "A newer custom summary",
              history: {
                ...fixture.handoff.history!,
                messages: fixture.handoff.history!.messages.map((message) => ({
                  ...message,
                  text: `${message.text} newly selected`,
                })),
              },
            },
            "event:handoff-receipt-race:newer",
          ),
        ],
      });
      const rewritten = yield* handoffRows([threadId]);
      yield* Deferred.succeed(releasePage, undefined);
      yield* Fiber.join(pass);

      assert.deepEqual(yield* handoffRows([threadId]), rewritten);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back a page of handoff rewrites when one fails", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:handoff-receipt-rollback");
    const fixture = legacyHandoff(threadId, now, "rollback");
    yield* sink.write({
      events: [
        threadCreated(makeThread(threadId, now), now),
        handoffEvent(fixture.handoff),
        handoffItemEvent(fixture.item),
      ],
    });
    const before = yield* handoffRows([threadId]);
    yield* sql`
      CREATE TRIGGER reject_handoff_rewrite
      BEFORE UPDATE OF payload_json ON orchestration_v2_projection_context_handoffs
      BEGIN SELECT RAISE(ABORT, 'test projection rewrite rejected'); END
    `;
    assert.equal((yield* maintenance.pruneEventStore().pipe(Effect.exit))._tag, "Failure");
    assert.deepEqual(yield* handoffRows([threadId]), before);
    yield* sql`DROP TRIGGER reject_handoff_rewrite`;
    yield* maintenance.pruneEventStore();
    const after = yield* handoffRows([threadId]);
    assert.isTrue(after.every((row) => row.summary === fixture.receipt));
  }).pipe(Effect.provide(layerTest)),
);
