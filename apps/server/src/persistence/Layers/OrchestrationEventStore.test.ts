import { Effect, Layer, Stream } from "effect";
import { assert, it } from "@effect/vitest";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { NodeServices } from "@effect/platform-node";

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(OrchestrationEventStoreLive, SqlitePersistenceMemory),
    NodeServices.layer,
  ),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores and replays events", () =>
    Effect.gen(function* () {
      const createdAt = new Date().toISOString();

      const eventStore = yield* OrchestrationEventStore;
      const saved = yield* eventStore.append({
        eventId: "event-1",
        type: "thread.created",
        aggregateType: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-1",
        payload: { id: "thread-1", projectId: "project-1", title: "demo" },
      });
      assert.equal(saved.sequence, 1);

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0)).pipe(
        Effect.map(Array.from),
      );
      assert.deepEqual(replayed, [saved]);
    }),
  );
});
