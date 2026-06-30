import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowBoardEvents } from "../Services/WorkflowBoardEvents.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardEventsLive } from "./WorkflowBoardEvents.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const layer = it.layer(
  WorkflowEventCommitterLive.pipe(
    Layer.provideMerge(WorkflowBoardEventsLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowBoardEvents", (it) => {
  it.effect("publishes a ticket delta after the committer projects a ticket event", () =>
    Effect.gen(function* () {
      const events = yield* WorkflowBoardEvents;
      const committer = yield* WorkflowEventCommitter;
      const registry = yield* BoardRegistry;
      yield* registry.register("b-1" as never, {
        name: "Board events",
        lanes: [{ key: "backlog", name: "Backlog", entry: "manual" }],
      });
      const deltasFiber = yield* events
        .stream("b-1" as never)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "e1" as never,
        ticketId: "t-1" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-1" as never,
          title: "Board delta" as never,
          laneKey: "backlog" as never,
        },
      });

      const deltas = Array.from(yield* Fiber.join(deltasFiber));
      assert.equal(deltas[0]?.ticketId, "t-1");
      assert.equal(deltas[0]?.boardId, "b-1");
      assert.equal(deltas[0]?.title, "Board delta");
      assert.equal(deltas[0]?.currentLaneKey, "backlog");
      assert.equal(deltas[0]?.status, "idle");
    }),
  );
});
