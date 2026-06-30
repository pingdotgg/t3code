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
import {
  WorkflowEventCommitter,
  type WorkflowEventCommitterShape,
} from "../Services/WorkflowEventCommitter.ts";
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

const failedExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "failed" as const, error: "hold slot" }),
} satisfies StepExecutorShape);

let selfRouteExecutionCount = 0;
const selfRouteExecutor = Layer.succeed(StepExecutor, {
  execute: () =>
    Effect.sync(() => {
      selfRouteExecutionCount += 1;
      if (selfRouteExecutionCount === 1) {
        return { _tag: "failed" as const, error: "retry in same lane" };
      }
      return { _tag: "blocked" as const, reason: "stop after retry" };
    }),
} satisfies StepExecutorShape);

const workflowLayer = (executor: Layer.Layer<StepExecutor>) =>
  WorkflowEngineLayer.pipe(
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(executor),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const layer = it.layer(workflowLayer(failedExecutor));

const selfRouteLayer = it.layer(workflowLayer(selfRouteExecutor));

const wipDefinition = {
  name: "wip",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      wipLimit: 1,
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const selfRouteDefinition = {
  name: "self route",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      wipLimit: 1,
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      on: { failure: "impl" },
    },
  ],
};

const manualCapacityDefinition = {
  name: "manual capacity",
  lanes: [{ key: "impl", name: "Impl", entry: "manual", wipLimit: 2 }],
};

const routedQueueDefinition = {
  name: "routed queue",
  lanes: [
    {
      key: "source",
      name: "Source",
      entry: "manual",
      wipLimit: 1,
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      on: { success: "target" },
    },
    { key: "target", name: "Target", entry: "manual", wipLimit: 1 },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const concurrentExitDefinition = {
  name: "concurrent exit",
  lanes: [
    { key: "source", name: "Source", entry: "manual", wipLimit: 1 },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const awaitTicketWhere = (ticketId: string, predicate: (detail: TicketDetail | null) => boolean) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    return yield* read.getTicketDetail(ticketId as never);
  });

const seedAdmittedTicket = (
  committer: WorkflowEventCommitterShape,
  boardId: string,
  ticketId: string,
  token: string,
  offset: number,
) =>
  Effect.gen(function* () {
    yield* committer.commit({
      type: "TicketCreated",
      eventId: `evt-${ticketId}-created` as never,
      ticketId: ticketId as never,
      occurredAt: `2026-06-07T00:10:${offset.toString().padStart(2, "0")}.000Z` as never,
      payload: {
        boardId: boardId as never,
        title: ticketId,
        laneKey: "impl" as never,
      },
    } as never);
    yield* committer.commit({
      type: "TicketMovedToLane",
      eventId: `evt-${ticketId}-admitted` as never,
      ticketId: ticketId as never,
      occurredAt: `2026-06-07T00:11:${offset.toString().padStart(2, "0")}.000Z` as never,
      payload: {
        toLane: "impl" as never,
        laneEntryToken: token as never,
        reason: "initial",
      },
    } as never);
  });

selfRouteLayer("WorkflowEngine same-lane WIP enforcement", (it) => {
  it.effect("re-admits an admitted auto ticket routed back into its own full lane", () =>
    Effect.gen(function* () {
      selfRouteExecutionCount = 0;
      const registry = yield* BoardRegistry;
      yield* registry.register("b-self-route" as never, selfRouteDefinition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-self-route" as never,
        title: "Retry",
        initialLane: "impl" as never,
      });
      const detail = yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.status === "blocked" && selfRouteExecutionCount === 2,
      );

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const starts = events.filter((event) => event.type === "PipelineStarted");
      const moves = events.filter((event) => event.type === "TicketMovedToLane");
      assert.equal(selfRouteExecutionCount, 2);
      assert.equal(starts.length, 2);
      assert.equal(moves.length, 2);
      assert.equal(moves[1]?.type, "TicketMovedToLane");
      if (moves[0]?.type !== "TicketMovedToLane" || moves[1]?.type !== "TicketMovedToLane") {
        assert.fail("expected initial and routed lane moves");
      }
      assert.equal(moves[1].payload.reason, "routed");
      assert.notEqual(moves[1].payload.laneEntryToken, moves[0].payload.laneEntryToken);
      assert.equal(detail?.ticket.currentLaneKey, "impl");
      assert.equal(detail?.ticket.currentLaneEntryToken, moves[1].payload.laneEntryToken);
      assert.isFalse(events.some((event) => event.type === "TicketQueued"));
    }),
  );
});

layer("WorkflowEngine WIP enforcement", (it) => {
  it.effect("discounts only the moving ticket for same-lane capacity checks", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const committer = yield* WorkflowEventCommitter;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;
      yield* registry.register("b-same-capacity-open" as never, manualCapacityDefinition);
      yield* registry.register("b-same-capacity-full" as never, manualCapacityDefinition);

      yield* seedAdmittedTicket(
        committer,
        "b-same-capacity-open",
        "ticket-open-self",
        "tok-open-self",
        1,
      );
      yield* seedAdmittedTicket(
        committer,
        "b-same-capacity-open",
        "ticket-open-other",
        "tok-open-other",
        2,
      );

      yield* engine.moveTicket("ticket-open-self" as never, "impl" as never);

      const openDetail = yield* read.getTicketDetail("ticket-open-self" as never);
      const openEvents = yield* Stream.runCollect(
        store.readByTicket("ticket-open-self" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const openMoves = openEvents.filter((event) => event.type === "TicketMovedToLane");
      assert.equal(openDetail?.ticket.status, "idle");
      assert.equal(openDetail?.ticket.currentLaneKey, "impl");
      assert.isNotNull(openDetail?.ticket.currentLaneEntryToken ?? null);
      assert.notEqual(openDetail?.ticket.currentLaneEntryToken, "tok-open-self");
      assert.equal(openMoves.length, 2);
      assert.isFalse(openEvents.some((event) => event.type === "TicketQueued"));

      yield* seedAdmittedTicket(
        committer,
        "b-same-capacity-full",
        "ticket-full-self",
        "tok-full-self",
        3,
      );
      yield* seedAdmittedTicket(
        committer,
        "b-same-capacity-full",
        "ticket-full-other-a",
        "tok-full-other-a",
        4,
      );
      yield* seedAdmittedTicket(
        committer,
        "b-same-capacity-full",
        "ticket-full-other-b",
        "tok-full-other-b",
        5,
      );

      yield* engine.moveTicket("ticket-full-self" as never, "impl" as never);

      const fullDetail = yield* read.getTicketDetail("ticket-full-self" as never);
      const fullEvents = yield* Stream.runCollect(
        store.readByTicket("ticket-full-self" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(fullDetail?.ticket.status, "queued");
      assert.equal(fullDetail?.ticket.currentLaneKey, "impl");
      assert.equal(fullDetail?.ticket.currentLaneEntryToken, null);
      assert.isTrue(fullEvents.some((event) => event.type === "TicketQueued"));
    }),
  );

  it.effect("queues a second initial entry into a full auto lane without starting a pipeline", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-wip" as never, wipDefinition);
      const engine = yield* WorkflowEngine;

      const firstTicketId = yield* engine.createTicket({
        boardId: "b-wip" as never,
        title: "First",
        initialLane: "impl" as never,
      });
      const firstDetail = yield* awaitTicketWhere(
        firstTicketId as string,
        (detail) =>
          detail?.ticket.status === "blocked" &&
          detail.ticket.currentLaneEntryToken !== null &&
          detail.steps.length === 1,
      );
      assert.equal(firstDetail?.ticket.currentLaneKey, "impl");
      assert.isNotNull(firstDetail?.ticket.currentLaneEntryToken ?? null);

      const secondTicketId = yield* engine.createTicket({
        boardId: "b-wip" as never,
        title: "Second",
        initialLane: "impl" as never,
      });
      const secondDetail = yield* awaitTicketWhere(
        secondTicketId as string,
        (detail) => detail?.ticket.status === "queued",
      );

      assert.equal(secondDetail?.ticket.currentLaneKey, "impl");
      assert.equal(secondDetail?.ticket.status, "queued");
      assert.equal(secondDetail?.ticket.currentLaneEntryToken, null);
      assert.isNotNull(secondDetail?.ticket.queuedAt ?? null);
      assert.equal(secondDetail?.steps.length, 0);
    }),
  );

  it.effect("queues a routed ticket into a full lane and admits the source lane FIFO", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const committer = yield* WorkflowEventCommitter;
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;
      const read = yield* WorkflowReadModel;
      yield* registry.register("b-routed-wip" as never, routedQueueDefinition);

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-target-created" as never,
        ticketId: "ticket-target-full" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-routed-wip" as never,
          title: "Target full",
          laneKey: "target" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-target-admitted" as never,
        ticketId: "ticket-target-full" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "target" as never,
          laneEntryToken: "tok-target-full" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-source-created" as never,
        ticketId: "ticket-source-routing" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          boardId: "b-routed-wip" as never,
          title: "Source routing",
          laneKey: "source" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-source-admitted" as never,
        ticketId: "ticket-source-routing" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          toLane: "source" as never,
          laneEntryToken: "tok-source-routing" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-source-pipeline" as never,
        ticketId: "ticket-source-routing" as never,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-source-routing" as never,
          laneKey: "source" as never,
          laneEntryToken: "tok-source-routing" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-source-step" as never,
        ticketId: "ticket-source-routing" as never,
        occurredAt: "2026-06-07T00:00:05.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-source-routing" as never,
          stepRunId: "step-source-routing" as never,
          stepKey: "code" as never,
          stepType: "agent",
        },
      } as never);
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-source-queued-created" as never,
        ticketId: "ticket-source-queued" as never,
        occurredAt: "2026-06-07T00:00:06.000Z" as never,
        payload: {
          boardId: "b-routed-wip" as never,
          title: "Source queued",
          laneKey: "source" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketQueued",
        eventId: "evt-source-queued" as never,
        ticketId: "ticket-source-queued" as never,
        occurredAt: "2026-06-07T00:00:07.000Z" as never,
        payload: { lane: "source" as never },
      } as never);

      yield* engine.completeRecoveredStep("step-source-routing" as never, { _tag: "completed" });

      const routedDetail = yield* read.getTicketDetail("ticket-source-routing" as never);
      const admittedDetail = yield* read.getTicketDetail("ticket-source-queued" as never);
      assert.equal(routedDetail?.ticket.currentLaneKey, "target");
      assert.equal(routedDetail?.ticket.status, "queued");
      assert.equal(routedDetail?.ticket.currentLaneEntryToken, null);
      assert.isNotNull(routedDetail?.ticket.queuedAt ?? null);
      assert.equal(admittedDetail?.ticket.currentLaneKey, "source");
      assert.equal(admittedDetail?.ticket.status, "idle");
      assert.isNotNull(admittedDetail?.ticket.currentLaneEntryToken ?? null);
      assert.equal(admittedDetail?.ticket.queuedAt, null);

      const events = yield* Stream.runCollect(
        store.readByTicket("ticket-source-routing" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const routeIndex = events.findIndex((event) => event.type === "TicketRouteDecided");
      const queueIndex = events.findIndex((event) => event.type === "TicketQueued");
      assert.isTrue(routeIndex >= 0 && queueIndex > routeIndex);
      assert.isFalse(
        events.some(
          (event) => event.type === "TicketMovedToLane" && event.payload.reason === "routed",
        ),
      );
    }),
  );

  it.effect("admits only one queued ticket after two concurrent exits from an overfull lane", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const committer = yield* WorkflowEventCommitter;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      yield* registry.register("b-concurrent-exit" as never, concurrentExitDefinition);

      const seedAdmitted = (ticketId: string, token: string, offset: number) =>
        Effect.gen(function* () {
          yield* committer.commit({
            type: "TicketCreated",
            eventId: `evt-${ticketId}-created` as never,
            ticketId: ticketId as never,
            occurredAt: `2026-06-07T00:01:0${offset}.000Z` as never,
            payload: {
              boardId: "b-concurrent-exit" as never,
              title: ticketId,
              laneKey: "source" as never,
            },
          } as never);
          yield* committer.commit({
            type: "TicketMovedToLane",
            eventId: `evt-${ticketId}-admitted` as never,
            ticketId: ticketId as never,
            occurredAt: `2026-06-07T00:01:1${offset}.000Z` as never,
            payload: {
              toLane: "source" as never,
              laneEntryToken: token as never,
              reason: "initial",
            },
          } as never);
        });
      const seedQueued = (ticketId: string, offset: number) =>
        Effect.gen(function* () {
          yield* committer.commit({
            type: "TicketCreated",
            eventId: `evt-${ticketId}-created` as never,
            ticketId: ticketId as never,
            occurredAt: `2026-06-07T00:02:0${offset}.000Z` as never,
            payload: {
              boardId: "b-concurrent-exit" as never,
              title: ticketId,
              laneKey: "source" as never,
            },
          } as never);
          yield* committer.commit({
            type: "TicketQueued",
            eventId: `evt-${ticketId}-queued` as never,
            ticketId: ticketId as never,
            occurredAt: `2026-06-07T00:02:1${offset}.000Z` as never,
            payload: { lane: "source" as never },
          } as never);
        });

      yield* seedAdmitted("ticket-exit-a", "tok-exit-a", 1);
      yield* seedAdmitted("ticket-exit-b", "tok-exit-b", 2);
      yield* seedQueued("ticket-queued-a", 1);
      yield* seedQueued("ticket-queued-b", 2);

      yield* Effect.all(
        [
          engine.moveTicket("ticket-exit-a" as never, "done" as never),
          engine.moveTicket("ticket-exit-b" as never, "done" as never),
        ],
        { concurrency: "unbounded" },
      );

      const queuedA = yield* read.getTicketDetail("ticket-queued-a" as never);
      const queuedB = yield* read.getTicketDetail("ticket-queued-b" as never);
      const admittedCount = yield* read.countAdmittedInLane(
        "b-concurrent-exit" as never,
        "source" as never,
      );
      const admittedQueuedTickets = [queuedA, queuedB].filter(
        (detail) => detail !== null && detail.ticket.currentLaneEntryToken !== null,
      );

      assert.equal(admittedCount, 1);
      assert.equal(admittedQueuedTickets.length, 1);
      assert.equal(queuedA?.ticket.status, "idle");
      assert.equal(queuedA?.ticket.queuedAt, null);
      assert.equal(queuedB?.ticket.status, "queued");
      assert.equal(queuedB?.ticket.currentLaneEntryToken, null);
    }),
  );
});
