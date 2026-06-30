// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const succeedingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "completed" as const }),
} satisfies StepExecutorShape);

const layer = it.layer(
  WorkflowEngineLayer.pipe(
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(succeedingExecutor),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const dependencyDefinition = {
  name: "deps",
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "work",
      name: "Work",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const awaitTicketWhere = (ticketId: string, predicate: (detail: TicketDetail | null) => boolean) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    return yield* read.getTicketDetail(ticketId as never);
  });

layer("WorkflowEngine ticket dependencies", (it) => {
  it.effect("queues a dependent in an auto lane and releases it when the dependency lands", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-deps" as never, dependencyDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const blocker = yield* engine.createTicket({
        boardId: "b-deps" as never,
        title: "Blocker",
        initialLane: "backlog" as never,
      });
      const dependent = yield* engine.createTicket({
        boardId: "b-deps" as never,
        title: "Dependent",
        initialLane: "work" as never,
        dependsOn: [blocker],
      });

      const queued = yield* read.getTicketDetail(dependent);
      assert.equal(queued?.ticket.status, "queued");
      assert.isNotNull(queued?.ticket.queuedAt);
      assert.deepEqual(queued?.ticket.dependsOn, [blocker as string]);
      assert.equal(queued?.ticket.unresolvedDependencyCount, 1);

      // Manual run is refused while the dependency is open.
      const refusal = yield* engine.runLane(dependent).pipe(Effect.flip);
      assert.include(refusal.message, "waiting on 1 unresolved dependency");

      // No pipeline may have started for the dependent yet.
      const eventsBefore = yield* Stream.runCollect(store.readByTicket(dependent)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isFalse(eventsBefore.some((event) => event.type === "PipelineStarted"));

      // Landing the blocker in the terminal lane auto-releases the dependent.
      yield* engine.moveTicket(blocker, "done" as never);
      const released = yield* awaitTicketWhere(
        dependent as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
      );
      assert.equal(released?.ticket.currentLaneKey, "done");
      assert.equal(released?.ticket.unresolvedDependencyCount, 0);

      const eventsAfter = yield* Stream.runCollect(store.readByTicket(dependent)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isTrue(eventsAfter.some((event) => event.type === "TicketAdmitted"));
      assert.isTrue(eventsAfter.some((event) => event.type === "PipelineStarted"));
    }),
  );

  it.effect("releases a queued dependent when an edit clears its last dependency", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-deps-edit" as never, dependencyDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const blocker = yield* engine.createTicket({
        boardId: "b-deps-edit" as never,
        title: "Blocker",
        initialLane: "backlog" as never,
      });
      const dependent = yield* engine.createTicket({
        boardId: "b-deps-edit" as never,
        title: "Dependent",
        initialLane: "work" as never,
        dependsOn: [blocker],
      });
      const queued = yield* read.getTicketDetail(dependent);
      assert.equal(queued?.ticket.status, "queued");

      yield* engine.editTicket({ ticketId: dependent, dependsOn: [] });

      const released = yield* awaitTicketWhere(
        dependent as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
      );
      assert.equal(released?.ticket.currentLaneKey, "done");
    }),
  );

  it.effect("rejects circular and invalid dependencies", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-deps-cycle" as never, dependencyDefinition);
      const engine = yield* WorkflowEngine;

      const first = yield* engine.createTicket({
        boardId: "b-deps-cycle" as never,
        title: "First",
        initialLane: "backlog" as never,
      });
      const second = yield* engine.createTicket({
        boardId: "b-deps-cycle" as never,
        title: "Second",
        initialLane: "backlog" as never,
      });

      yield* engine.editTicket({ ticketId: first, dependsOn: [second] });
      const cycle = yield* engine
        .editTicket({ ticketId: second, dependsOn: [first] })
        .pipe(Effect.flip);
      assert.include(cycle.message, "circular");

      const selfDependency = yield* engine
        .editTicket({ ticketId: first, dependsOn: [first] })
        .pipe(Effect.flip);
      assert.include(selfDependency.message, "depend on itself");

      const missing = yield* engine
        .createTicket({
          boardId: "b-deps-cycle" as never,
          title: "Broken",
          initialLane: "backlog" as never,
          dependsOn: ["ticket-i-do-not-exist" as never],
        })
        .pipe(Effect.flip);
      assert.include(missing.message, "was not found");
    }),
  );
});
