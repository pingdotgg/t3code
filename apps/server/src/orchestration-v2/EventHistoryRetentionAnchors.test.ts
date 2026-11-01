import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  createdEvent,
  layerTest,
  makeThread,
  messageEvent,
  metadataUpdatedEvent,
  promptEvents,
  providerInstanceId,
  runningEvent,
  visitedEvent,
} from "./EventHistoryRetentionTestSupport.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";

it.effect("retention keeps replay anchors and leaves project and thread projections intact", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const oldAt = yield* DateTime.now;

    const anchoredThreadId = ThreadId.make("thread:retention-anchors");
    const anchoredThread = makeThread(anchoredThreadId, oldAt);
    const run: OrchestrationV2Run = {
      id: RunId.make(`run:${anchoredThreadId}`),
      threadId: anchoredThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${anchoredThreadId}:run`),
      rootNodeId: null,
      activeAttemptId: RunAttemptId.make(`run-attempt:${anchoredThreadId}`),
      status: "running",
      queuePosition: null,
      requestedAt: oldAt,
      startedAt: oldAt,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* sink.write({
      events: [
        createdEvent(anchoredThread, oldAt),
        runningEvent(anchoredThreadId, run, "first", oldAt),
        runningEvent(anchoredThreadId, run, "later", oldAt),
        ...promptEvents(anchoredThreadId, oldAt, 0),
        ...promptEvents(anchoredThreadId, oldAt, 1),
        ...promptEvents(anchoredThreadId, oldAt, 2),
      ],
    });
    const commandId = CommandId.make("command:retention:receipt");
    const commandEvent = messageEvent(anchoredThreadId, "receipt", oldAt);
    yield* sink.commitCommand({
      commandId,
      threadId: anchoredThreadId,
      commandType: "thread.send",
      acceptedAt: oldAt,
      events: [commandEvent],
      effects: [],
    });

    const importingThreadId = ThreadId.make("thread:retention-importing");
    const importingThread = makeThread(importingThreadId, oldAt);
    const importedMessages = [
      messageEvent(importingThreadId, "one", oldAt),
      messageEvent(importingThreadId, "two", oldAt),
    ];
    yield* sink.write({ events: [createdEvent(importingThread, oldAt), ...importedMessages] });
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports (
        thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
        imported_message_count, last_error
      ) VALUES (
        ${importingThreadId}, ${DateTime.formatIso(oldAt)}, ${DateTime.formatIso(oldAt)}, NULL, 0, NULL
      )
    `;

    const highWaterThreadId = ThreadId.make("thread:retention-old-high-water");
    const highWaterThread = makeThread(highWaterThreadId, oldAt);
    const oldLatest = metadataUpdatedEvent(highWaterThread, "latest", "Latest old state", oldAt);
    yield* sink.write({ events: [createdEvent(highWaterThread, oldAt), oldLatest] });

    const archivedThreadId = ThreadId.make("thread:retention-archived");
    const archivedThread = makeThread(archivedThreadId, oldAt);
    const archivedEvent = {
      id: EventId.make(`event:${archivedThreadId}:archived`),
      type: "thread.archived",
      threadId: archivedThreadId,
      providerInstanceId,
      occurredAt: oldAt,
      payload: { ...archivedThread, archivedAt: oldAt },
    } satisfies OrchestrationV2DomainEvent;
    yield* sink.write({ events: [createdEvent(archivedThread, oldAt), archivedEvent] });

    const projectId = ProjectId.make("project:retention-project");
    const projectEvent = yield* applicationEvents.appendProjectEvent({
      eventId: EventId.make("event:retention-project:old"),
      type: "project.meta-updated",
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(oldAt),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { projectId, title: "Old project", updatedAt: DateTime.formatIso(oldAt) },
    });

    yield* TestClock.adjust(Duration.hours(25));
    const recentAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        ...promptEvents(anchoredThreadId, recentAt, 3),
        visitedEvent(anchoredThread, "recent", recentAt),
        visitedEvent(importingThread, "recent", recentAt),
        visitedEvent({ ...archivedThread, archivedAt: oldAt }, "recent", recentAt),
      ],
    });

    const before = [
      yield* projections.getThreadProjection(anchoredThreadId),
      yield* projections.getThreadProjection(importingThreadId),
      yield* projections.getThreadProjection(highWaterThreadId),
      yield* projections.getThreadProjection(archivedThreadId),
    ];
    assert.isAbove((yield* maintenance.compactEventStore()).deletedEventCount, 0);

    const anchored = yield* events.read({ threadId: anchoredThreadId }).pipe(Stream.runCollect);
    const anchoredIds = new Set(anchored.map((stored) => stored.event.id));
    for (const id of [
      "event:thread:retention-anchors:run:first",
      "event:thread:retention-anchors:run:later",
      commandEvent.id,
      "event:thread:retention-anchors:subagent:1",
      "event:thread:retention-anchors:subagent-item:1",
    ]) {
      assert.include(anchoredIds, id);
    }
    for (const suffix of ["subagent:0", "subagent-item:0"]) {
      assert.notInclude(anchoredIds, `event:thread:retention-anchors:${suffix}`);
    }
    const compressedPrompt = anchored.find(
      (stored) => stored.event.id === "event:thread:retention-anchors:subagent:3",
    )?.event;
    assert.equal(
      compressedPrompt?.type === "subagent.updated" ? compressedPrompt.payload.prompt : null,
      "Prompt B. ".repeat(40),
    );
    const fullPrompt = anchored.find(
      (stored) => stored.event.id === "event:thread:retention-anchors:subagent:1",
    )?.event;
    assert.equal(
      fullPrompt?.type === "subagent.updated" ? fullPrompt.payload.prompt : null,
      "Prompt B. ".repeat(40),
    );

    const importing = yield* events.read({ threadId: importingThreadId }).pipe(Stream.runCollect);
    const importingIds = new Set(importing.map((stored) => stored.event.id));
    for (const event of importedMessages) assert.include(importingIds, event.id);

    const highWater = yield* events.read({ threadId: highWaterThreadId }).pipe(Stream.runCollect);
    assert.include(
      highWater.map((stored) => stored.event.id),
      oldLatest.id,
    );
    const archived = yield* events.read({ threadId: archivedThreadId }).pipe(Stream.runCollect);
    assert.notInclude(
      archived.map((stored) => stored.event.id),
      archivedEvent.id,
    );
    const projectReplay = yield* applicationEvents
      .readApplicationEvents({
        afterSequence: projectEvent.sequence - 1,
        throughSequence: projectEvent.sequence,
      })
      .pipe(Stream.runCollect);
    assert.deepEqual(
      projectReplay.map((stored) => {
        if (!("aggregateKind" in stored)) return null;
        return stored.eventId;
      }),
      [projectEvent.eventId],
    );

    assert.deepEqual(
      [
        yield* projections.getThreadProjection(anchoredThreadId),
        yield* projections.getThreadProjection(importingThreadId),
        yield* projections.getThreadProjection(highWaterThreadId),
        yield* projections.getThreadProjection(archivedThreadId),
      ],
      before,
    );
    assert.isTrue((yield* maintenance.verify).valid);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("retention keeps a deleted thread tombstone for old cursors", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:retention-deleted");
    const thread = makeThread(threadId, now);
    const [createdStored] = yield* sink.write({
      events: [createdEvent(thread, now), messageEvent(threadId, "before-delete", now)],
    });

    yield* TestClock.adjust(Duration.hours(25));
    const deletedAt = yield* DateTime.now;
    const deleted = {
      id: EventId.make(`event:${threadId}:deleted`),
      type: "thread.deleted",
      threadId,
      providerInstanceId,
      occurredAt: deletedAt,
      payload: { ...thread, deletedAt },
    } satisfies OrchestrationV2DomainEvent;
    yield* sink.write({ events: [deleted] });

    assert.equal((yield* maintenance.compactEventStore()).deletedEventCount, 1);
    const retained = yield* events.read({ threadId }).pipe(Stream.runCollect);
    assert.deepEqual(
      retained.map((stored) => stored.event.id),
      [createdStored!.event.id, deleted.id],
    );
    assert.isNull(yield* projections.getThreadShell(threadId));

    const resumed = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: createdStored!.sequence,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        getThreadShell: projections.getThreadShell,
        getThreadSnapshot: projections.getThreadSnapshot,
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(resumed, (item) => item.kind),
      ["event", "synchronized"],
    );
    assert.equal(resumed[0]?.kind === "event" ? resumed[0].event.type : null, "thread.deleted");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a prompt reference added before deletion does not advance the replay floor", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const oldAt = yield* DateTime.now;
    const thread = makeThread(ThreadId.make("thread:prompt-reference-race"), oldAt);
    yield* sink.write({
      events: [createdEvent(thread, oldAt), ...promptEvents(thread.id, oldAt, 1)],
    });
    yield* TestClock.adjust(Duration.hours(25));
    const now = yield* DateTime.now;
    yield* sink.write({ events: [visitedEvent(thread, "recent", now)] });
    let inserted = false;
    const addReference: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (!inserted && query.includes("DELETE FROM orchestration_events AS candidate")) {
        inserted = true;
        return sink
          .write({ events: promptEvents(thread.id, now, 2) })
          .pipe(Effect.orDie, Effect.as(statement));
      }
      return Effect.succeed(statement);
    };
    const result = yield* maintenance
      .compactEventStore()
      .pipe(Effect.provideService(Statement.CurrentTransformer, addReference));
    assert.isTrue(inserted);
    assert.equal(result.deletedEventCount, 0);
    assert.equal(yield* applicationEvents.replayFloor(thread.id), 0);
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_event_retention`, []);
  }).pipe(Effect.provide(layerTest)),
);
