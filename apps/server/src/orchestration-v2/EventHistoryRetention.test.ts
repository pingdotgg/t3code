import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import {
  createdEvent,
  layerTest,
  makeThread,
  metadataUpdatedEvent,
  visitedEvent,
} from "./EventHistoryRetentionTestSupport.ts";

it.effect("prunes expired thread history while preserving current projections", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const createdAt = yield* DateTime.now;
    const threadId = ThreadId.make("thread:event-history-retention");
    const thread = makeThread(threadId, createdAt);
    const created = createdEvent(thread, createdAt);
    const oldMetadata = metadataUpdatedEvent(thread, "old", "Old title", createdAt);
    const [createdStored, oldMetadataStored] = yield* sink.write({
      events: [created, oldMetadata],
    });

    yield* TestClock.adjust(Duration.hours(25));
    const recentAt = yield* DateTime.now;
    const recent = visitedEvent(thread, "recent", recentAt);
    yield* sink.write({ events: [recent] });
    const before = yield* projections.getThreadProjection(threadId);

    const result = yield* maintenance.compactEventStore();
    const retained = yield* events.read({ threadId }).pipe(Stream.runCollect);

    assert.equal(result.deletedEventCount, 1);
    assert.deepEqual(
      retained.map((stored) => stored.event.id),
      [created.id, recent.id],
    );
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
    assert.equal(yield* applicationEvents.replayFloor(threadId), oldMetadataStored!.sequence);
    assert.equal(yield* applicationEvents.replayFloor(), oldMetadataStored!.sequence);
    assert.isTrue((yield* maintenance.verify).valid);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(maintenance.rebuild)));
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);

    const resume = (afterSequence: number) =>
      subscribeOrchestrationV2Thread({
        threadId,
        afterSequence,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.map((item) => item.kind),
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
    const resumed = yield* resume(createdStored!.sequence);
    assert.deepEqual(Array.from(resumed), ["snapshot", "synchronized"]);
    const resumedAtFloor = yield* resume(oldMetadataStored!.sequence);
    assert.deepEqual(Array.from(resumedAtFloor), ["event", "synchronized"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread resume falls back when retention commits during event replay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const threadId = ThreadId.make("thread:event-history-retention-race");
      const thread = makeThread(threadId, createdAt);
      const [createdStored] = yield* sink.write({
        events: [
          createdEvent(thread, createdAt),
          metadataUpdatedEvent(thread, "old", "Old title", createdAt),
        ],
      });
      yield* TestClock.adjust(Duration.hours(25));
      const recentAt = yield* DateTime.now;
      yield* sink.write({ events: [visitedEvent(thread, "recent", recentAt)] });

      const replayReadStarted = yield* Deferred.make<void>();
      const releaseReplayRead = yield* Deferred.make<void>();
      let blocked = false;
      const blockReplayRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (!blocked && query.includes("event_id") && query.includes("ORDER BY sequence ASC")) {
          blocked = true;
          return Deferred.succeed(replayReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReplayRead)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const resume = subscribeOrchestrationV2Thread({
        threadId,
        afterSequence: createdStored!.sequence,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.map((item) => item.kind),
            Stream.runCollect,
          ),
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadShell: projections.getThreadShell,
          getThreadSnapshot: projections.getThreadSnapshot,
          streamStoredEventsFrom: () => Stream.never,
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(Statement.CurrentTransformer, blockReplayRead),
      );
      const resumedFiber = yield* Effect.forkScoped(resume);
      yield* Deferred.await(replayReadStarted);
      const result = yield* maintenance.compactEventStore();
      yield* Deferred.succeed(releaseReplayRead, undefined);

      assert.equal(result.deletedEventCount, 1);
      assert.deepEqual(Array.from(yield* Fiber.join(resumedFiber)), ["snapshot", "synchronized"]);
    }).pipe(Effect.provide(layerTest)),
  ),
);

it.effect("retention stays off when the replay floor table is missing", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const thread = makeThread(ThreadId.make("thread:retention-without-floor"), now);
    const oldEvent = metadataUpdatedEvent(thread, "old", "Old title", now);
    yield* sink.write({ events: [createdEvent(thread, now), oldEvent] });
    yield* sql`DROP TABLE orchestration_v2_event_retention`;
    yield* TestClock.adjust(Duration.hours(25));

    assert.equal((yield* maintenance.compactEventStore()).deletedEventCount, 0);
    const retained = yield* events.read({ threadId: thread.id }).pipe(Stream.runCollect);
    assert.include(
      retained.map((stored) => stored.event.id),
      oldEvent.id,
    );
  }).pipe(Effect.provide(layerTest)),
);
