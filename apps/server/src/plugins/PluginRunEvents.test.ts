import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginRunEvents from "./PluginRunEvents.ts";

const layer = PluginRunEvents.layer.pipe(
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const runEvent = (id: string, status: OrchestrationV2Run["status"]): OrchestrationV2DomainEvent => {
  const now = DateTime.makeUnsafe("2026-11-10T12:00:00Z");
  const provider = ProviderInstanceId.make("replay");
  const threadId = ThreadId.make("thread:plugin-events");
  return {
    id: EventId.make(`event:${id}:${status}`),
    type: "run.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: RunId.make(id),
      threadId,
      ordinal: 1,
      providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: "replay" },
      providerThreadId: null,
      userMessageId: MessageId.make("message:plugin-events"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "running" ? null : now,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
};

it.layer(layer)("PluginRunEvents", (it) => {
  it.effect(
    "replays finished runs, follows new outcomes, and resumes after an acknowledged cursor",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore.OrchestrationEventStore;
        const events = yield* PluginRunEvents.PluginRunEvents;
        const [running, finished, rolledBack] = yield* store.appendAgentEvents({
          events: [
            runEvent("run:one", "running"),
            runEvent("run:one", "completed"),
            runEvent("run:old", "rolled_back"),
          ],
        });
        assert.isDefined(running);
        assert.isDefined(finished);
        assert.isDefined(rolledBack);
        const pull = yield* Stream.toPull(events.runs({ afterSequence: 0 }));
        assert.deepStrictEqual(yield* pull, [
          {
            sequence: finished!.sequence,
            deliveryId: "event:run:one:completed",
            type: "run.finished",
            threadId: "thread:plugin-events",
            runId: "run:one",
            status: "completed",
            completedAt: "2026-11-10T12:00:00.000Z",
          },
        ]);

        const started = yield* Deferred.make<void>();
        const newEvents = yield* PluginRunEvents.PluginRunEvents.use((fresh) =>
          fresh.runs().pipe(Stream.take(1), Stream.runCollect),
        ).pipe(
          Effect.provide(
            Layer.fresh(
              PluginRunEvents.layer.pipe(
                Layer.provide(
                  Layer.succeed(OrchestrationEventStore.OrchestrationEventStore, {
                    ...store,
                    latestApplicationSequence: store.latestApplicationSequence.pipe(
                      Effect.tap(() => Deferred.succeed(started, undefined)),
                    ),
                  }),
                ),
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        const [failed] = yield* store.appendAgentEvents({
          events: [runEvent("run:two", "failed")],
        });
        yield* store.publishCommitted([failed!]);
        assert.deepStrictEqual(
          (yield* Fiber.join(newEvents)).map((event) => event.runId),
          ["run:two"],
        );
        const live = yield* pull;
        assert.deepStrictEqual(
          live.map((event) => [event.runId, event.status]),
          [["run:two", "failed"]],
        );
        const resumed = yield* events
          .runs({ afterSequence: finished!.sequence })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(resumed, [...live]);
      }).pipe(Effect.scoped),
  );

  it.effect("preserves delivery ids on replay and distinguishes retries and later updates", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const events = yield* PluginRunEvents.PluginRunEvents;
      const afterSequence = yield* store.latestApplicationSequence;
      const first = runEvent("run:repeated", "interrupted");
      const later = { ...first, id: EventId.make("event:repeated:checkpoint") };
      yield* store.appendAgentEvents({
        events: [
          first,
          later,
          runEvent("run:repeated", "preparing"),
          runEvent("run:repeated", "failed"),
          runEvent("run:repeated", "completed"),
          runEvent("run:cancelled", "cancelled"),
        ],
      });
      const replayed = yield* events
        .runs({ afterSequence })
        .pipe(Stream.take(5), Stream.runCollect);
      assert.deepStrictEqual(
        replayed.map((event) => event.deliveryId),
        [
          first.id,
          later.id,
          "event:run:repeated:failed",
          "event:run:repeated:completed",
          "event:run:cancelled:cancelled",
        ],
      );
      const replayedAgain = yield* events
        .runs({ afterSequence })
        .pipe(Stream.take(5), Stream.runCollect);
      assert.deepStrictEqual(replayedAgain, replayed);
      assert.isBelow(replayed[0]!.sequence, replayed[1]!.sequence);
    }),
  );

  it.effect("rejects invalid cursors and reports when acknowledged history has been pruned", () =>
    Effect.gen(function* () {
      const events = yield* PluginRunEvents.PluginRunEvents;
      for (const afterSequence of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const error = yield* events.runs({ afterSequence }).pipe(Stream.runCollect, Effect.flip);
        assert.instanceOf(error, PluginRunEvents.PluginRunEventCursorError);
      }
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const prunedThroughSequence = yield* store.latestApplicationSequence;
      yield* sql`
        INSERT OR REPLACE INTO orchestration_v2_projection_metadata
          (projection_name, schema_version, last_sequence, updated_at)
        VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 1, ${prunedThroughSequence}, '2026-11-10T12:00:00Z')
      `;
      const error = yield* events.runs({ afterSequence: 0 }).pipe(Stream.runCollect, Effect.flip);
      assert.instanceOf(error, PluginRunEvents.PluginRunEventHistoryPrunedError);
      if (error._tag === "PluginRunEventHistoryPrunedError") {
        assert.strictEqual(error.afterSequence, 0);
        assert.strictEqual(error.prunedThroughSequence, prunedThroughSequence);
      }

      const afterSequence = prunedThroughSequence;
      const [finished] = yield* store.appendAgentEvents({
        events: [runEvent("run:pruned-during-replay", "completed")],
      });
      const concurrentPrune = yield* events.runs({ afterSequence }).pipe(
        Stream.tap(
          () => sql`
          UPDATE orchestration_v2_projection_metadata SET last_sequence = ${finished!.sequence}
          WHERE projection_name = ${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}
        `,
        ),
        Stream.runDrain,
        Effect.flip,
      );
      assert.strictEqual(concurrentPrune._tag, "PluginRunEventHistoryPrunedError");
    }),
  );
});
