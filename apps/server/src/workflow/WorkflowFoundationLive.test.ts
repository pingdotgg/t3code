import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "./Services/BoardRegistry.ts";
import { WorkflowEventStore } from "./Services/WorkflowEventStore.ts";
import { WorkflowProjectionPipeline } from "./Services/WorkflowProjectionPipeline.ts";
import { WorkflowReadModel } from "./Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "./WorkflowFoundationLive.ts";

// WorkflowFoundationLive already provides AND re-exports BoardRegistry (the read
// model depends on it), so the foundation stack alone satisfies BoardRegistry.
const layer = it.layer(
  WorkflowFoundationLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowFoundationLive", (it) => {
  it.effect("provides event store and read model together", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const read = yield* WorkflowReadModel;
      assert.isDefined(store.append);
      assert.isDefined(read.getBoard);
    }),
  );

  it.effect("read model resolves lane actions from the same registry boards register into", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const pipeline = yield* WorkflowProjectionPipeline;
      const read = yield* WorkflowReadModel;

      // Register the definition via BoardRegistry, then read it back through the
      // read model — if these were separate registry instances, getTicketDetail
      // would see no definition and fall back to an empty actions array.
      yield* registry.register("b-shared-registry" as never, {
        name: "Shared registry board",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "manual",
            actions: [{ label: "Approve", to: "done", hint: "Ship it" }],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "shared-registry-a" as never,
        ticketId: "t-shared-registry" as never,
        streamVersion: 0,
        occurredAt: "2026-06-08T00:00:00.000Z" as never,
        payload: {
          boardId: "b-shared-registry" as never,
          title: "Shared" as never,
          laneKey: "review" as never,
        },
      });

      const detail = yield* read.getTicketDetail("t-shared-registry" as never);
      assert.deepEqual(detail?.ticket.currentLane, {
        key: "review",
        name: "Review",
        actions: [{ label: "Approve", to: "done", hint: "Ship it" }],
      });
    }),
  );
});
