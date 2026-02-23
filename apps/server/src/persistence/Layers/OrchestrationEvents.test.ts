import { Effect, Layer } from "effect";
import { assert, it } from "@effect/vitest";

import { OrchestrationEventRepository } from "../Services/OrchestrationEvents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OrchestrationEventRepositoryLive } from "./OrchestrationEvents.ts";
import { NodeServices } from "@effect/platform-node";

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(OrchestrationEventRepositoryLive, SqlitePersistenceMemory),
    NodeServices.layer,
  ),
);

layer("OrchestrationEventRepository", (it) => {
  it.effect("stores and replays events", () =>
    Effect.gen(function* () {
      const createdAt = new Date().toISOString();

      const repository = yield* OrchestrationEventRepository;
      const saved = yield* repository.append({
        eventId: "event-1",
        type: "thread.created",
        aggregateType: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-1",
        payload: { id: "thread-1", projectId: "project-1", title: "demo" },
      });
      assert.equal(saved.sequence, 1);

      const replayed = yield* repository.readFromSequence(0);
      assert.deepEqual(replayed, [saved]);
    }),
  );
});
