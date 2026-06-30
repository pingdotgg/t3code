// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ProviderTurnPort } from "../Services/ProviderDispatchOutbox.ts";
import {
  ProviderResponsePort,
  type ProviderResponseInput,
} from "../Services/ProviderResponsePort.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { ProviderDispatchOutboxLive } from "./ProviderDispatchOutbox.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";
import { makeStubStepExecutor } from "./StubStepExecutor.ts";

const definition = {
  name: "wf",
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      on: { success: "done", failure: "needs" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const baseLayer = (
  executor: Layer.Layer<StepExecutor>,
  boardRegistry: Layer.Layer<BoardRegistry> = BoardRegistryLive,
) =>
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
    Layer.provideMerge(boardRegistry),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const awaitLane = (ticketId: string, laneKey: string) =>
  awaitTicketWhere(ticketId, (detail) => detail?.ticket.currentLaneKey === laneKey);

const awaitStatus = (ticketId: string, status: string) =>
  awaitTicketWhere(ticketId, (detail) => detail?.ticket.status === status);

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

const awaitDeferredWithinYields = (deferred: Deferred.Deferred<void>, label: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Deferred.await(deferred));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const exit = yield* Effect.sync(() => fiber.pollUnsafe());
      if (exit !== undefined) {
        return yield* Fiber.join(fiber);
      }
      yield* Effect.yieldNow;
    }
    yield* Fiber.interrupt(fiber);
    assert.fail(`Timed out waiting for ${label}`);
  });

const successLayer = it.layer(baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } })));

successLayer("WorkflowEngine integration", (it) => {
  it.effect("auto lane runs the pipeline and routes to done", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-1" as never, definition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-1" as never,
        title: "Export",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "done");
      assert.equal(detail?.ticket.currentLaneKey, "done");
      assert.equal(
        detail?.steps.some((step) => step.status === "completed"),
        true,
      );
    }),
  );

  it.effect("edits ticket title and description metadata", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-edit" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-edit" as never,
        title: "Original title",
        description: "Original description",
        initialLane: "backlog" as never,
      });

      yield* engine.editTicket({
        ticketId,
        title: "  Updated title  ",
        description: "",
      });

      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.title, "Updated title");
      assert.equal(detail?.ticket.description, "");
    }),
  );
});

const failLayer = it.layer(
  baseLayer(makeStubStepExecutor({ default: { _tag: "failed", error: "boom" } })),
);

failLayer("WorkflowEngine integration failure path", (it) => {
  it.effect("failed step routes to the failure lane", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-fail" as never, definition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-fail" as never,
        title: "Fix",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(
        detail?.steps.some((step) => step.status === "failed"),
        true,
      );
    }),
  );
});

const stepOnDefinition = {
  name: "step-on-wf",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "first",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "first",
          on: { success: "needs" },
        },
        {
          key: "second",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "second",
        },
      ],
      on: { success: "done" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const transitionDefinition = {
  name: "transition-wf",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "review",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "review",
          captureOutput: true,
        },
      ],
      transitions: [
        { when: { "==": [{ var: "steps.review.output.verdict" }, "pass"] }, to: "done" },
        { when: { "==": [{ var: "steps.review.output.verdict" }, "block"] }, to: "needs" },
      ],
      on: { success: "done" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const recoveredCaptureReadErrorDefinition = {
  name: "recovered-capture-read-error-wf",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "review",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "review",
          captureOutput: true,
        },
      ],
      on: { success: "done", failure: "needs" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const noRouteFailureDefinition = {
  name: "no-route-wf",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "fail",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "fail",
        },
      ],
    },
  ],
};

const routeDecisionLayer = it.layer(
  baseLayer(
    makeStubStepExecutor({
      default: { _tag: "completed" },
      byStepKey: {
        review: { _tag: "completed", output: { verdict: "block" } },
        fail: { _tag: "failed", error: "boom" },
      },
    }),
  ),
);

const providerContinuationLayer = it.layer(
  baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } })).pipe(
    Layer.provideMerge(ProviderDispatchOutboxLive),
    Layer.provideMerge(
      Layer.succeed(CapturedStepOutputReader, {
        read: () => Effect.succeed({ verdict: "block" }),
      }),
    ),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: () => Effect.die("unused provider turn start"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TurnStateReader, {
        read: () => Effect.succeed({ _tag: "completed" as const }),
      }),
    ),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const recoveredCaptureReadErrorLayer = it.layer(
  baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } })).pipe(
    Layer.provideMerge(
      Layer.succeed(CapturedStepOutputReader, {
        read: () =>
          Effect.fail(new WorkflowEventStoreError({ message: "simulated repository failure" })),
      }),
    ),
  ),
);

routeDecisionLayer("WorkflowEngine smart route decisions", (it) => {
  it.effect("step on success short-circuits remaining steps and emits route audit", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-step-on" as never, stepOnDefinition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-step-on" as never,
        title: "Step route",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.deepEqual(
        detail?.steps.map((step) => step.stepKey),
        ["first"],
      );

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const routeIndex = events.findIndex((event) => event.type === "TicketRouteDecided");
      const moveIndex = events.findIndex(
        (event) => event.type === "TicketMovedToLane" && event.payload.reason === "routed",
      );
      const audit = events.find((event) => event.type === "TicketRouteDecided");
      assert.isTrue(routeIndex >= 0);
      assert.equal(moveIndex, routeIndex + 1);
      assert.equal(audit?.type, "TicketRouteDecided");
      if (audit?.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(audit.payload.source, "step_on");
      assert.equal(audit.payload.toLane, "needs");
    }),
  );

  it.effect("lane transitions first-match before lane on fallback", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-transition" as never, transitionDefinition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-transition" as never,
        title: "Transition route",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const audit = events.find((event) => event.type === "TicketRouteDecided");
      assert.equal(audit?.type, "TicketRouteDecided");
      if (audit?.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(audit.payload.source, "lane_transition");
      assert.equal(audit.payload.matchedTransitionIndex, 1);
      assert.deepEqual((audit.payload.contextSnapshot as any).steps.review.output, {
        verdict: "block",
      });
    }),
  );

  it.effect("lane on fallback still emits route audit", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-lane-on-audit" as never, definition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-lane-on-audit" as never,
        title: "Lane route",
        initialLane: "impl" as never,
      });

      yield* awaitLane(ticketId as string, "done");
      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const audit = events.find((event) => event.type === "TicketRouteDecided");
      assert.equal(audit?.type, "TicketRouteDecided");
      if (audit?.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(audit.payload.source, "lane_on");
      assert.equal(audit.payload.toLane, "done");
    }),
  );

  it.effect("failure with no route keeps TicketBlocked and emits no route audit", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-no-route" as never, noRouteFailureDefinition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-no-route" as never,
        title: "No route",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitStatus(ticketId as string, "blocked");
      assert.equal(detail?.ticket.status, "blocked");
      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isFalse(events.some((event) => event.type === "TicketRouteDecided"));
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "TicketBlocked" &&
            event.payload.reason === "pipeline failure with no route",
        ),
      );
    }),
  );

  it.effect("recovered step on success short-circuits remaining steps", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-recovered-step-on" as never, stepOnDefinition);
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const store = yield* WorkflowEventStore;

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-recovered-ticket" as never,
        ticketId: "ticket-recovered-step-on" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-recovered-step-on" as never,
          title: "Recovered step",
          laneKey: "impl" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-recovered-move-in" as never,
        ticketId: "ticket-recovered-step-on" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "tok-recovered-step-on" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-recovered-pipeline" as never,
        ticketId: "ticket-recovered-step-on" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-recovered-step-on" as never,
          laneKey: "impl" as never,
          laneEntryToken: "tok-recovered-step-on" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-recovered-step" as never,
        ticketId: "ticket-recovered-step-on" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-recovered-step-on" as never,
          stepRunId: "step-recovered-step-on" as never,
          stepKey: "first" as never,
          stepType: "agent",
        },
      } as never);

      yield* engine.completeRecoveredStep("step-recovered-step-on" as never, {
        _tag: "completed",
      });

      const detail = yield* awaitLane("ticket-recovered-step-on", "needs");
      assert.deepEqual(
        detail?.steps.map((step) => step.stepKey),
        ["first"],
      );
      const events = yield* Stream.runCollect(
        store.readByTicket("ticket-recovered-step-on" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const audit = events.find((event) => event.type === "TicketRouteDecided");
      assert.equal(audit?.type, "TicketRouteDecided");
      if (audit?.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(audit.payload.source, "step_on");
      assert.equal(audit.payload.toLane, "needs");
    }),
  );

  it.effect("stale recovered completion emits no route audit after token supersede", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-stale-token" as never, stepOnDefinition);
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const store = yield* WorkflowEventStore;

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-stale-token-ticket" as never,
        ticketId: "ticket-stale-token" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-stale-token" as never,
          title: "Stale token",
          laneKey: "impl" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-stale-token-move-in" as never,
        ticketId: "ticket-stale-token" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "tok-stale-token-old" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-stale-token-pipeline" as never,
        ticketId: "ticket-stale-token" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-stale-token" as never,
          laneKey: "impl" as never,
          laneEntryToken: "tok-stale-token-old" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-stale-token-step" as never,
        ticketId: "ticket-stale-token" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-stale-token" as never,
          stepRunId: "step-stale-token" as never,
          stepKey: "first" as never,
          stepType: "agent",
        },
      } as never);

      yield* engine.moveTicket("ticket-stale-token" as never, "needs" as never);
      yield* engine.completeRecoveredStep("step-stale-token" as never, {
        _tag: "completed",
      });

      const detail = yield* awaitLane("ticket-stale-token", "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");

      const events = yield* Stream.runCollect(
        store.readByTicket("ticket-stale-token" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.isFalse(events.some((event) => event.type === "TicketRouteDecided"));
      assert.isFalse(
        events.some(
          (event) => event.type === "TicketMovedToLane" && event.payload.reason === "routed",
        ),
      );
    }),
  );
});

recoveredCaptureReadErrorLayer("WorkflowEngine recovered capture output failures", (it) => {
  it.effect("terminalizes recovered captureOutput steps when structured output lookup fails", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recovered-capture-read-error" as never,
        recoveredCaptureReadErrorDefinition,
      );
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const store = yield* WorkflowEventStore;

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-recovered-capture-read-error-ticket" as never,
        ticketId: "ticket-recovered-capture-read-error" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-recovered-capture-read-error" as never,
          title: "Recovered capture read error",
          laneKey: "impl" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-recovered-capture-read-error-move-in" as never,
        ticketId: "ticket-recovered-capture-read-error" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "tok-recovered-capture-read-error" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-recovered-capture-read-error-pipeline" as never,
        ticketId: "ticket-recovered-capture-read-error" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-recovered-capture-read-error" as never,
          laneKey: "impl" as never,
          laneEntryToken: "tok-recovered-capture-read-error" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-recovered-capture-read-error-step" as never,
        ticketId: "ticket-recovered-capture-read-error" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-recovered-capture-read-error" as never,
          stepRunId: "step-recovered-capture-read-error" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      } as never);

      const exit = yield* engine
        .completeRecoveredStep(
          "step-recovered-capture-read-error" as never,
          { _tag: "completed" },
          {
            threadId: "thread-recovered-capture-read-error" as never,
            turnId: "turn-recovered-capture-read-error" as never,
          },
        )
        .pipe(Effect.exit);

      assert.isTrue(Exit.isSuccess(exit));

      const detail = yield* awaitLane("ticket-recovered-capture-read-error", "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(detail?.steps.find((step) => step.stepKey === "review")?.status, "failed");

      const events = yield* Stream.runCollect(
        store.readByTicket("ticket-recovered-capture-read-error" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "StepFailed" &&
            event.payload.stepRunId === "step-recovered-capture-read-error" &&
            event.payload.error === "structured output lookup failed",
        ),
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "PipelineCompleted" && event.payload.result === "failure",
        ),
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "TicketRouteDecided" &&
            event.payload.source === "lane_on" &&
            event.payload.toLane === "needs",
        ),
      );
    }),
  );
});

providerContinuationLayer("WorkflowEngine provider continuation routing", (it) => {
  it.effect("routes recovered provider approval continuation with captured output", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-provider-continuation" as never, transitionDefinition);
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const providerOutput = 'Review complete.\n```json\n{"verdict":"block"}\n```';

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-provider-ticket" as never,
        ticketId: "ticket-provider-continuation" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-provider-continuation" as never,
          title: "Provider continuation",
          laneKey: "impl" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-provider-move" as never,
        ticketId: "ticket-provider-continuation" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "tok-provider-continuation" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-provider-pipeline" as never,
        ticketId: "ticket-provider-continuation" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-provider-continuation" as never,
          laneKey: "impl" as never,
          laneEntryToken: "tok-provider-continuation" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-provider-step" as never,
        ticketId: "ticket-provider-continuation" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-provider-continuation" as never,
          stepRunId: "step-provider-continuation" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      } as never);
      yield* committer.commit({
        type: "StepAwaitingUser",
        eventId: "evt-provider-await" as never,
        ticketId: "ticket-provider-continuation" as never,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          stepRunId: "step-provider-continuation" as never,
          waitingReason: "Provider needs approval",
          providerThreadId: "thread-provider-continuation" as never,
          providerRequestId: "request-provider-continuation" as never,
          providerResponseKind: "request",
        },
      } as never);
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          turn_id,
          created_at,
          started_at
        )
        VALUES (
          'dispatch-provider-continuation',
          'ticket-provider-continuation',
          'step-provider-continuation',
          'thread-provider-continuation',
          'codex',
          'gpt-5.5',
          'Review the test result',
          '/tmp/wt-provider-continuation',
          'started',
          'turn-provider-continuation',
          '2026-06-07T00:00:05.000Z',
          '2026-06-07T00:00:05.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'assistant-provider-continuation',
          'thread-provider-continuation',
          'turn-provider-continuation',
          'assistant',
          ${providerOutput},
          NULL,
          0,
          '2026-06-07T00:00:06.000Z',
          '2026-06-07T00:00:06.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-provider-continuation',
          'turn-provider-continuation',
          NULL,
          NULL,
          NULL,
          'assistant-provider-continuation',
          'completed',
          '2026-06-07T00:00:05.000Z',
          '2026-06-07T00:00:05.000Z',
          '2026-06-07T00:00:06.000Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      yield* engine.resolveApproval("step-provider-continuation" as never, true);

      const detail = yield* awaitLane("ticket-provider-continuation", "needs");
      assert.deepEqual(detail?.steps.find((step) => step.stepKey === "review")?.output, {
        verdict: "block",
      });
      assert.equal(
        (yield* read.getTicketDetail("ticket-provider-continuation" as never))?.ticket
          .currentLaneKey,
        "needs",
      );
    }),
  );
});

const blockedDefinition = {
  name: "blocked-wf",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      on: { success: "done", failure: "needs", blocked: "trust" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "trust", name: "Trust", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const blockedLayer = it.layer(
  baseLayer(
    makeStubStepExecutor({
      default: { _tag: "blocked", reason: "Project not trusted to run scripts" } as never,
    }),
  ),
);

blockedLayer("WorkflowEngine integration blocked path", (it) => {
  it.effect("blocked step routes through the lane blocked target and records its reason", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-blocked" as never, blockedDefinition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-blocked" as never,
        title: "Trust",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "trust");
      assert.equal(detail?.ticket.currentLaneKey, "trust");
      assert.equal(detail?.steps[0]?.status, "blocked");
      assert.equal(detail?.steps[0]?.blockedReason, "Project not trusted to run scripts");

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "StepBlocked" &&
            event.payload.reason === "Project not trusted to run scripts",
        ),
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "PipelineCompleted" && event.payload.result === "blocked",
        ),
      );
    }),
  );
});

const explodingExecutor = Layer.succeed(StepExecutor, {
  execute: () =>
    Effect.fail(new WorkflowEventStoreError({ message: "executor exploded" })) as never,
} satisfies StepExecutorShape);

const explodingLayer = it.layer(baseLayer(explodingExecutor));

explodingLayer("WorkflowEngine pipeline error handling", (it) => {
  it.effect("records a failed step and routes when the executor effect fails", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-explodes" as never, definition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-explodes" as never,
        title: "Explode",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(detail?.steps[0]?.status, "failed");
    }),
  );
});

let capturedLaneKey: string | undefined;
let capturedLaneStepKeys: ReadonlyArray<string> | undefined;

const capturingLaneContextExecutor = Layer.succeed(StepExecutor, {
  execute: (ctx) =>
    Effect.sync(() => {
      capturedLaneKey = ctx.laneKey as string;
      capturedLaneStepKeys = ctx.laneStepKeys as ReadonlyArray<string>;
      return { _tag: "completed" as const };
    }),
} satisfies StepExecutorShape);

const capturingLaneContextLayer = it.layer(baseLayer(capturingLaneContextExecutor));

capturingLaneContextLayer("WorkflowEngine step context lane wiring", (it) => {
  it.effect("populates ctx.laneKey and ctx.laneStepKeys from the running lane", () =>
    Effect.gen(function* () {
      capturedLaneKey = undefined;
      capturedLaneStepKeys = undefined;
      const registry = yield* BoardRegistry;
      yield* registry.register("b-lane-ctx" as never, definition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-lane-ctx" as never,
        title: "Lane context",
        initialLane: "impl" as never,
      });

      yield* awaitLane(ticketId as string, "done");
      assert.equal(capturedLaneKey, "impl");
      assert.deepEqual(capturedLaneStepKeys, ["code"]);
    }),
  );
});

const failingDefinitionRegistry = Layer.succeed(BoardRegistry, {
  register: () => Effect.succeed(definition as never),
  unregister: () => Effect.void,
  getLane: (_boardId, laneKey) =>
    Effect.succeed((definition.lanes.find((lane) => lane.key === laneKey) ?? null) as never),
  getDefinition: () => Effect.die("definition unavailable"),
  listDefinitions: () => Effect.succeed([]),
});

const pipelineFailureLayer = it.layer(
  baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } }), failingDefinitionRegistry),
);

pipelineFailureLayer("WorkflowEngine orchestration error handling", (it) => {
  it.effect("blocks and logs when pipeline orchestration fails before the first step", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-pipeline-fails" as never,
        title: "Pipeline fails",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitStatus(ticketId as string, "blocked");
      assert.equal(detail?.ticket.status, "blocked");
      assert.equal(detail?.steps.length, 0);
      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const blocked = events.find((event) => event.type === "TicketBlocked");
      assert.include(blocked?.payload.reason ?? "", "definition unavailable");
      assert.isTrue(
        messages.some((message) => message.includes("workflow pipeline orchestration failed")),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});

const approvalDefinition = {
  name: "approval-wf",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "auto",
      pipeline: [{ key: "ok", type: "approval", prompt: "Approve?" }],
      on: { success: "done", failure: "needs" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

successLayer("WorkflowEngine approval gate", (it) => {
  it.effect("parks on approval then routes on approve", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-approval" as never, approvalDefinition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-approval" as never,
        title: "Approve me",
        initialLane: "review" as never,
      });

      const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
      assert.equal(waitingDetail?.ticket.status, "waiting_on_user");
      const stepRunId = waitingDetail?.steps[0]?.stepRunId;
      assert.isString(stepRunId);

      yield* engine.resolveApproval(stepRunId as never, true);
      const doneDetail = yield* awaitLane(ticketId as string, "done");
      assert.equal(doneDetail?.ticket.currentLaneKey, "done");
    }),
  );

  it.effect("moveTicket fails for an unknown ticket instead of silently succeeding", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const exit = yield* engine
        .moveTicket("ticket-does-not-exist" as never, "needs" as never)
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      assert.instanceOf(error, WorkflowEventStoreError);
      assert.match((error as WorkflowEventStoreError).message, /ticket-does-not-exist not found/);
    }),
  );

  it.effect("answerTicketStep fails for an unknown stepRunId instead of silently succeeding", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const exit = yield* engine
        .answerTicketStep({
          stepRunId: "step-run-does-not-exist" as never,
          text: "an answer that should not be dropped",
          attachments: [],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      assert.instanceOf(error, WorkflowEventStoreError);
      assert.match((error as WorkflowEventStoreError).message, /step-run-does-not-exist not found/);
    }),
  );
});

const awaitingUserDefinition = {
  name: "awaiting-user-wf",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "question",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "ask",
        },
      ],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

it.effect("answerTicketStep posts both messages, delivers text, and resumes the parked turn", () =>
  Effect.gen(function* () {
    const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const answerLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: "Which API should I use?",
          providerThreadId: "thread-ticket-answer" as never,
          providerRequestId: "request-ticket-answer" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-api-choice",
        } as never,
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-answer" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-ticket-answer" as never,
        title: "Answer me",
        initialLane: "impl" as never,
      });
      const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
      const stepRunId = waitingDetail?.steps[0]?.stepRunId;
      assert.isString(stepRunId);
      assert.deepEqual(
        waitingDetail?.messages.map((message) => [message.author, message.body]),
        [["agent", "Which API should I use?"]],
      );

      yield* engine.answerTicketStep({
        stepRunId: stepRunId as never,
        text: "Use the sandbox endpoint.",
        attachments: [],
      });

      const doneDetail = yield* awaitLane(ticketId as string, "done");
      const calls = yield* Ref.get(providerResponses);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.responseKind, "user-input");
      assert.equal(
        (calls[0] as { readonly questionId?: string } | undefined)?.questionId,
        "question-api-choice",
      );
      assert.equal(calls[0]?.text, "Use the sandbox endpoint.");
      assert.deepEqual(
        (yield* read.getTicketDetail(ticketId))?.messages.map((message) => [
          message.author,
          message.body,
        ]),
        [
          ["agent", "Which API should I use?"],
          ["user", "Use the sandbox endpoint."],
        ],
      );
      assert.equal(doneDetail?.ticket.currentLaneKey, "done");
    }).pipe(Effect.provide(answerLayer));
  }),
);

it.effect(
  "answerTicketStep rejects stale provider user-input waits until a live request is visible",
  () =>
    Effect.gen(function* () {
      const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
      const providerWaitState = yield* Ref.make<"stale" | "live">("stale");
      const staleGuardLayer = baseLayer(
        makeStubStepExecutor({ default: { _tag: "completed" } }),
      ).pipe(
        Layer.provideMerge(ProviderDispatchOutboxLive),
        Layer.provideMerge(
          Layer.succeed(ProviderTurnPort, {
            ensureTurnStarted: () => Effect.die("unused provider turn start"),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(TurnStateReader, {
            read: (threadId) =>
              Ref.get(providerResponses).pipe(
                Effect.zip(Ref.get(providerWaitState)),
                Effect.map(([responses, state]) => {
                  if (responses.length > 0) {
                    return { _tag: "completed" as const };
                  }
                  if (state === "live") {
                    return {
                      _tag: "awaiting_user" as const,
                      waitingReason: "Live provider question",
                      providerThreadId: threadId,
                      providerRequestId: "request-live-answer" as never,
                      providerResponseKind: "user-input" as const,
                      providerQuestionId: "question-live-answer",
                    };
                  }
                  return { _tag: "running" as const };
                }),
              ),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderResponsePort, {
            respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
          }),
        ),
        Layer.provideMerge(MigrationsLive),
        Layer.provideMerge(SqlitePersistenceMemory),
      );

      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        const engine = yield* WorkflowEngine;
        const committer = yield* WorkflowEventCommitter;
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        yield* registry.register("b-stale-answer" as never, awaitingUserDefinition);

        yield* committer.commit({
          type: "TicketCreated",
          eventId: "evt-stale-answer-created" as never,
          ticketId: "ticket-stale-answer" as never,
          occurredAt: "2026-06-07T00:00:00.000Z" as never,
          payload: {
            boardId: "b-stale-answer" as never,
            title: "Stale answer",
            laneKey: "impl" as never,
          },
        } as never);
        yield* committer.commit({
          type: "TicketMovedToLane",
          eventId: "evt-stale-answer-moved" as never,
          ticketId: "ticket-stale-answer" as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: {
            toLane: "impl" as never,
            laneEntryToken: "token-stale-answer" as never,
            reason: "initial",
          },
        } as never);
        yield* committer.commit({
          type: "PipelineStarted",
          eventId: "evt-stale-answer-pipeline" as never,
          ticketId: "ticket-stale-answer" as never,
          occurredAt: "2026-06-07T00:00:02.000Z" as never,
          payload: {
            pipelineRunId: "pipeline-stale-answer" as never,
            laneKey: "impl" as never,
            laneEntryToken: "token-stale-answer" as never,
          },
        } as never);
        yield* committer.commit({
          type: "StepStarted",
          eventId: "evt-stale-answer-step" as never,
          ticketId: "ticket-stale-answer" as never,
          occurredAt: "2026-06-07T00:00:03.000Z" as never,
          payload: {
            pipelineRunId: "pipeline-stale-answer" as never,
            stepRunId: "step-stale-answer" as never,
            stepKey: "question" as never,
            stepType: "agent",
          },
        } as never);
        yield* committer.commit({
          type: "StepAwaitingUser",
          eventId: "evt-stale-answer-await" as never,
          ticketId: "ticket-stale-answer" as never,
          occurredAt: "2026-06-07T00:00:04.000Z" as never,
          payload: {
            stepRunId: "step-stale-answer" as never,
            waitingReason: "Stale provider question",
            providerThreadId: "thread-stale-answer" as never,
            providerRequestId: "request-stale-answer" as never,
            providerResponseKind: "user-input",
            providerQuestionId: "question-stale-answer",
          },
        } as never);
        yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          turn_id,
          created_at,
          started_at
        )
        VALUES (
          'dispatch-stale-answer',
          'ticket-stale-answer',
          'step-stale-answer',
          'thread-stale-answer',
          'codex',
          'gpt-5.5',
          'ask',
          '/tmp/stale-answer',
          'started',
          'turn-stale-answer',
          '2026-06-07T00:00:04.000Z',
          '2026-06-07T00:00:04.000Z'
        )
      `;

        const staleExit = yield* Effect.exit(
          engine.answerTicketStep({
            stepRunId: "step-stale-answer" as never,
            text: "Use the stale answer.",
          }),
        );
        assert.isTrue(Exit.isFailure(staleExit));
        if (Exit.isFailure(staleExit)) {
          assert.include(String(staleExit.cause), "retry");
        }
        assert.deepEqual(yield* Ref.get(providerResponses), []);

        const detailAfterStaleAnswer = yield* read.getTicketDetail("ticket-stale-answer" as never);
        assert.equal(detailAfterStaleAnswer?.ticket.status, "waiting_on_user");
        assert.equal(detailAfterStaleAnswer?.steps[0]?.status, "awaiting_user");
        assert.isFalse(
          detailAfterStaleAnswer?.messages.some((message) => message.author === "user") ?? false,
        );
        const resolvedBeforeLive = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id = 'ticket-stale-answer'
          AND event_type = 'StepUserResolved'
      `;
        assert.equal(resolvedBeforeLive[0]?.count, 0);

        yield* Ref.set(providerWaitState, "live");
        yield* sql`
        UPDATE workflow_dispatch_outbox
        SET turn_id = 'turn-live-answer'
        WHERE dispatch_id = 'dispatch-stale-answer'
      `;
        yield* committer.commit({
          type: "StepAwaitingUser",
          eventId: "evt-live-answer-await" as never,
          ticketId: "ticket-stale-answer" as never,
          occurredAt: "2026-06-07T00:00:05.000Z" as never,
          payload: {
            stepRunId: "step-stale-answer" as never,
            waitingReason: "Live provider question",
            providerThreadId: "thread-stale-answer" as never,
            providerRequestId: "request-live-answer" as never,
            providerResponseKind: "user-input",
            providerQuestionId: "question-live-answer",
          },
        } as never);

        yield* engine.answerTicketStep({
          stepRunId: "step-stale-answer" as never,
          text: "Use the live answer.",
        });

        assert.deepEqual(
          (yield* Ref.get(providerResponses)).map((response) => ({
            requestId: response.requestId as string,
            questionId: response.questionId,
            text: response.text,
          })),
          [
            {
              requestId: "request-live-answer",
              questionId: "question-live-answer",
              text: "Use the live answer.",
            },
          ],
        );
      }).pipe(Effect.provide(staleGuardLayer));
    }),
);

it.effect("truncates over-long provider prompts before posting agent ticket messages", () =>
  Effect.gen(function* () {
    const longPrompt = `${"x".repeat(8_010)} tail`;
    const promptLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: longPrompt,
          providerThreadId: "thread-ticket-long-prompt" as never,
          providerRequestId: "request-ticket-long-prompt" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-ticket-long-prompt",
        } as never,
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: () => Effect.void,
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-long-prompt" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-ticket-long-prompt" as never,
        title: "Long prompt",
        initialLane: "impl" as never,
      });
      const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
      const body = waitingDetail?.messages[0]?.body ?? "";

      assert.equal(body.length, 8_000);
      assert.isTrue(body.endsWith("..."));
      assert.isFalse(body.includes(" tail"));
    }).pipe(Effect.provide(promptLayer));
  }),
);

it.effect("answerTicketStep rejects attachment-only answers and keeps the step awaiting", () =>
  Effect.gen(function* () {
    const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const imageOnlyLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: "Attach a screenshot.",
          providerThreadId: "thread-ticket-image-only" as never,
          providerRequestId: "request-ticket-image-only" as never,
          providerResponseKind: "user-input",
        },
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-image-only" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-ticket-image-only" as never,
        title: "Need screenshot",
        initialLane: "impl" as never,
      });
      const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
      const stepRunId = waitingDetail?.steps[0]?.stepRunId;
      assert.isString(stepRunId);

      // Provider responses are text-only: an attachment-only reply could never
      // resume the parked turn, so it must fail before posting any message.
      const exit = yield* Effect.exit(
        engine.answerTicketStep({
          stepRunId: stepRunId as never,
          attachments: [
            {
              kind: "image",
              id: "image-only",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 1200,
              dataUrl: "data:image/png;base64,AAAA",
            },
          ],
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(String(exit.cause), "requires text");
      }

      const detail = yield* read.getTicketDetail(ticketId);
      const calls = yield* Ref.get(providerResponses);
      assert.equal(calls.length, 0);
      assert.equal(detail?.ticket.status, "waiting_on_user");
      assert.equal(detail?.steps[0]?.status, "awaiting_user");
      assert.deepEqual(
        detail?.messages.map((message) => [message.author, message.body]),
        [["agent", "Attach a screenshot."]],
      );
    }).pipe(Effect.provide(imageOnlyLayer));
  }),
);

it.effect("answerTicketStep rejects non-awaiting steps without posting a user message", () =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    yield* registry.register("b-ticket-answer-completed" as never, awaitingUserDefinition);
    const engine = yield* WorkflowEngine;
    const read = yield* WorkflowReadModel;

    const ticketId = yield* engine.createTicket({
      boardId: "b-ticket-answer-completed" as never,
      title: "Already answered",
      initialLane: "impl" as never,
    });
    const doneDetail = yield* awaitLane(ticketId as string, "done");
    const stepRunId = doneDetail?.steps[0]?.stepRunId;
    assert.isString(stepRunId);

    const exit = yield* Effect.exit(
      engine.answerTicketStep({
        stepRunId: stepRunId as never,
        text: "This should not be posted.",
      }),
    );
    assert.isTrue(Exit.isFailure(exit));

    const detail = yield* read.getTicketDetail(ticketId);
    assert.deepEqual(detail?.messages, []);
  }).pipe(Effect.provide(baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } })))),
);

it.effect(
  "answerTicketStep rejects provider approval requests without posting a user message",
  () =>
    Effect.gen(function* () {
      const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
      const requestLayer = baseLayer(
        makeStubStepExecutor({
          default: {
            _tag: "awaiting_user",
            waitingReason: "Approve this command?",
            providerThreadId: "thread-ticket-request" as never,
            providerRequestId: "request-ticket-request" as never,
            providerResponseKind: "request",
          },
        }),
      ).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderResponsePort, {
            respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-ticket-answer-request" as never, awaitingUserDefinition);
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;

        const ticketId = yield* engine.createTicket({
          boardId: "b-ticket-answer-request" as never,
          title: "Approve me",
          initialLane: "impl" as never,
        });
        const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
        const stepRunId = waitingDetail?.steps[0]?.stepRunId;
        assert.isString(stepRunId);

        const exit = yield* Effect.exit(
          engine.answerTicketStep({
            stepRunId: stepRunId as never,
            text: "This should not be posted.",
          }),
        );
        assert.isTrue(Exit.isFailure(exit));

        const detail = yield* read.getTicketDetail(ticketId);
        assert.deepEqual(detail?.messages, []);
        assert.deepEqual(yield* Ref.get(providerResponses), []);
      }).pipe(Effect.provide(requestLayer));
    }),
);

it.effect("answerTicketStep rejects over-limit reply bodies and attachments", () =>
  Effect.gen(function* () {
    const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const limitLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: "Provide details.",
          providerThreadId: "thread-ticket-limits" as never,
          providerRequestId: "request-ticket-limits" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-ticket-limits",
        } as never,
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
        }),
      ),
    );

    const image = (id: string, dataUrl = "data:image/png;base64,AAAA") => ({
      kind: "image" as const,
      id,
      name: `${id}.png`,
      mimeType: "image/png" as const,
      sizeBytes: dataUrl.length,
      dataUrl,
    });

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-limits" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const assertRejected = Effect.fn("assertRejected")(function* (
        title: string,
        input: {
          readonly text?: string;
          readonly attachments?: ReadonlyArray<ReturnType<typeof image>>;
        },
      ) {
        const ticketId = yield* engine.createTicket({
          boardId: "b-ticket-limits" as never,
          title,
          initialLane: "impl" as never,
        });
        const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
        const stepRunId = waitingDetail?.steps[0]?.stepRunId;
        assert.isString(stepRunId);

        const exit = yield* Effect.exit(
          engine.answerTicketStep({
            stepRunId: stepRunId as never,
            ...input,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));

        const detail = yield* read.getTicketDetail(ticketId);
        assert.deepEqual(
          detail?.messages.map((message) => [message.author, message.body]),
          [["agent", "Provide details."]],
        );
      });

      yield* assertRejected("Too many attachments", {
        text: "See attached.",
        attachments: Array.from({ length: 7 }, (_, index) => image(`image-${index}`)),
      });
      yield* assertRejected("Too much image data", {
        text: "See attached.",
        attachments: [image("huge", `data:image/png;base64,${"A".repeat(10 * 1024 * 1024)}`)],
      });
      yield* assertRejected("Too much text", {
        text: "x".repeat(8001),
      });

      assert.deepEqual(yield* Ref.get(providerResponses), []);
    }).pipe(Effect.provide(limitLayer));
  }),
);

it.effect("answerTicketStep rejects non-image attachments before storing messages", () =>
  Effect.gen(function* () {
    const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const attachmentKindLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: "Attach an image.",
          providerThreadId: "thread-ticket-attachment-kind" as never,
          providerRequestId: "request-ticket-attachment-kind" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-ticket-attachment-kind",
        } as never,
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-attachment-kind" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const assertRejectedAttachment = Effect.fn("assertRejectedAttachment")(function* (
        title: string,
        attachment: NonNullable<
          Parameters<typeof engine.answerTicketStep>[0]["attachments"]
        >[number],
      ) {
        const ticketId = yield* engine.createTicket({
          boardId: "b-ticket-attachment-kind" as never,
          title,
          initialLane: "impl" as never,
        });
        const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
        const stepRunId = waitingDetail?.steps[0]?.stepRunId;
        assert.isString(stepRunId);

        const exit = yield* Effect.exit(
          engine.answerTicketStep({
            stepRunId: stepRunId as never,
            text: "See attached.",
            attachments: [attachment],
          }),
        );
        assert.isTrue(Exit.isFailure(exit));

        const detail = yield* read.getTicketDetail(ticketId);
        assert.deepEqual(
          detail?.messages.map((message) => [message.author, message.body]),
          [["agent", "Attach an image."]],
        );
      });

      yield* assertRejectedAttachment("Reject video", {
        kind: "video",
        id: "video-attachment",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1200,
        ref: "ticket-media/video-attachment",
      });
      yield* assertRejectedAttachment("Reject file", {
        kind: "file",
        id: "file-attachment",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1200,
        ref: "ticket-media/file-attachment",
      });

      assert.deepEqual(yield* Ref.get(providerResponses), []);
    }).pipe(Effect.provide(attachmentKindLayer));
  }),
);

it.effect("answerTicketStep rejects SVG image data URLs before storing messages", () =>
  Effect.gen(function* () {
    const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const svgLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: "Attach a raster image.",
          providerThreadId: "thread-ticket-svg" as never,
          providerRequestId: "request-ticket-svg" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-ticket-svg",
        } as never,
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-svg" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-ticket-svg" as never,
        title: "Reject SVG",
        initialLane: "impl" as never,
      });
      const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
      const stepRunId = waitingDetail?.steps[0]?.stepRunId;
      assert.isString(stepRunId);

      const exit = yield* Effect.exit(
        engine.answerTicketStep({
          stepRunId: stepRunId as never,
          text: "See attached.",
          attachments: [
            {
              kind: "image",
              id: "svg-attachment",
              name: "payload.svg",
              mimeType: "image/svg+xml",
              sizeBytes: 1200,
              dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
            } as never,
          ],
        }),
      );
      assert.isTrue(Exit.isFailure(exit));

      const detail = yield* read.getTicketDetail(ticketId);
      assert.deepEqual(
        detail?.messages.map((message) => [message.author, message.body]),
        [["agent", "Attach a raster image."]],
      );
      assert.deepEqual(yield* Ref.get(providerResponses), []);
    }).pipe(Effect.provide(svgLayer));
  }),
);

let supersedeStarted: Deferred.Deferred<void> | undefined;
let supersedeInterrupted: Deferred.Deferred<void> | undefined;
let supersedeRelease: Deferred.Deferred<void> | undefined;
let routedAutoStarted: Deferred.Deferred<void> | undefined;
let routedAutoRelease: Deferred.Deferred<void> | undefined;
let routedAutoCompletions = 0;

const blockingSuccessExecutor = Layer.effect(
  StepExecutor,
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    supersedeStarted = started;
    supersedeInterrupted = interrupted;
    supersedeRelease = release;

    return StepExecutor.of({
      execute: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return { _tag: "completed" as const };
        }).pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.ignore)),
        ),
    } satisfies StepExecutorShape);
  }),
);

const supersedeLayer = it.layer(baseLayer(blockingSuccessExecutor));

supersedeLayer("WorkflowEngine manual move supersede", (it) => {
  it.effect("manual move prevents a stale pipeline from routing the ticket", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-supersede" as never, definition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-supersede" as never,
        title: "Hold position",
        initialLane: "impl" as never,
      });
      yield* Effect.yieldNow;
      assert.exists(supersedeStarted);
      assert.exists(supersedeRelease);
      yield* awaitDeferredWithinYields(supersedeStarted, "supersede start");
      yield* engine.moveTicket(ticketId, "needs" as never);
      yield* Deferred.succeed(supersedeRelease, undefined);

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
    }),
  );

  it.effect("manual move interrupts the stale running pipeline", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-hard-supersede" as never, definition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-hard-supersede" as never,
        title: "Interrupt stale work",
        initialLane: "impl" as never,
      });
      yield* Effect.yieldNow;
      assert.exists(supersedeStarted);
      assert.exists(supersedeInterrupted);
      yield* awaitDeferredWithinYields(supersedeStarted, "hard supersede start");

      yield* engine.moveTicket(ticketId, "needs" as never);

      yield* awaitDeferredWithinYields(supersedeInterrupted, "hard supersede interrupt");
      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
    }),
  );
});

const routedAutoDefinition = {
  name: "routed-auto-wf",
  lanes: [
    {
      key: "route",
      name: "Route",
      entry: "auto",
      pipeline: [
        {
          key: "route-step",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "route",
        },
      ],
      on: { success: "routed" },
    },
    {
      key: "routed",
      name: "Routed",
      entry: "auto",
      pipeline: [
        {
          key: "routed-step",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "routed work",
        },
      ],
      on: { success: "done" },
    },
    { key: "manual", name: "Manual", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const routedAutoBlockingExecutor = Layer.effect(
  StepExecutor,
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    routedAutoStarted = started;
    routedAutoRelease = release;
    routedAutoCompletions = 0;

    return StepExecutor.of({
      execute: (ctx) => {
        if (ctx.step.key !== "routed-step") {
          return Effect.succeed({ _tag: "completed" as const });
        }

        return Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          routedAutoCompletions += 1;
          return { _tag: "completed" as const };
        }).pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.ignore)),
        );
      },
    } satisfies StepExecutorShape);
  }),
);

const routedAutoSupersedeLayer = it.layer(baseLayer(routedAutoBlockingExecutor));

routedAutoSupersedeLayer("WorkflowEngine routed auto lane supersede", (it) => {
  it.effect("starts the routed auto pipeline and lets a manual move interrupt it", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-routed-auto-supersede" as never, routedAutoDefinition);
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-routed-auto-supersede" as never,
        title: "Interrupt routed lane",
        initialLane: "route" as never,
      });
      assert.exists(routedAutoStarted);
      assert.exists(routedAutoRelease);
      yield* awaitDeferredWithinYields(routedAutoStarted, "routed auto start");

      const moveFiber = yield* Effect.forkChild(engine.moveTicket(ticketId, "manual" as never));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const exit = yield* Effect.sync(() => moveFiber.pollUnsafe());
        if (exit !== undefined) {
          break;
        }
        yield* Effect.yieldNow;
      }
      const moveExitBeforeRelease = yield* Effect.sync(() => moveFiber.pollUnsafe());
      if (moveExitBeforeRelease === undefined) {
        yield* Deferred.succeed(routedAutoRelease, undefined);
        yield* Effect.yieldNow;
      }

      assert.exists(
        moveExitBeforeRelease,
        "manual move should complete while the routed auto lane is still blocked",
      );
      yield* Deferred.succeed(routedAutoRelease, undefined);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const detail = yield* awaitLane(ticketId as string, "manual");
      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(detail?.ticket.currentLaneKey, "manual");
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "TicketMovedToLane" &&
            event.payload.toLane === "routed" &&
            event.payload.reason === "routed",
        ),
      );
      assert.equal(routedAutoCompletions, 0);
      assert.isFalse(
        events.some(
          (event) => event.type === "StepCompleted" && event.payload.stepRunId === "steprun-2",
        ),
      );
    }),
  );
});

// ── Defensive missing-target-lane routing (self-improve E6) ─────────────────
// A routed move may resolve to a lane key that is absent from the current board
// def (e.g. the lane was removed via the editor between route evaluation and the
// commit). The engine must NOT commit a TicketMovedToLane into a phantom lane.
//
// We model this with a NON-LINTING stub registry whose `impl` lane routes
// `on.success → "ghost"`, where "ghost" is not among the def's lanes — so
// `getLane(boardId, "ghost")` returns null at commit time.
const missingLaneDefinition = {
  name: "wf-missing-lane",
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      // Routes to a lane that does NOT exist in `lanes`.
      on: { success: "ghost", failure: "ghost" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
} as const;

// A stub BoardRegistry that does NOT lint (so the dangling lane ref is allowed)
// and resolves lanes only against the def's own `lanes` array — so "ghost" → null.
const missingLaneRegistryLayer = Layer.effect(
  BoardRegistry,
  Effect.sync(() => {
    const def = missingLaneDefinition as never;
    const lanes = missingLaneDefinition.lanes;
    return {
      register: () => Effect.succeed(def),
      unregister: () => Effect.void,
      getDefinition: () => Effect.succeed(def),
      listDefinitions: () => Effect.succeed([{ boardId: "b-missing" as never, definition: def }]),
      getLane: (_boardId, laneKey) =>
        Effect.succeed((lanes.find((lane) => lane.key === (laneKey as string)) ?? null) as never),
    };
  }),
);

const missingLaneLayer = it.layer(
  baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } }), missingLaneRegistryLayer),
);

missingLaneLayer("WorkflowEngine missing-target-lane routing", (it) => {
  it.effect(
    "routed move to a missing lane blocks the ticket for attention (no phantom-lane move)",
    () =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;

        const store = yield* WorkflowEventStore;

        const ticketId = yield* engine.createTicket({
          boardId: "b-missing" as never,
          title: "Phantom route",
          initialLane: "impl" as never,
        });

        // The guard emits TicketBlocked right after the pipeline completes and the
        // routed target resolves to the missing lane. Wait on the projected status
        // (deterministic) then inspect the event log.
        const detail = yield* awaitStatus(ticketId as string, "blocked");
        assert.equal(detail?.ticket.status, "blocked");
        // Still in its old lane (not silently parked in a phantom lane).
        assert.equal(detail?.ticket.currentLaneKey, "impl");

        const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        // We never commit a move/queue into the phantom "ghost" lane.
        assert.isFalse(
          events.some(
            (event) =>
              (event.type === "TicketMovedToLane" || event.type === "TicketQueued") &&
              (event.payload as { readonly toLane?: string; readonly lane?: string }).toLane ===
                "ghost",
          ),
        );
        // The block carries a clear reason naming the missing lane.
        const blocked = events.find((event) => event.type === "TicketBlocked");
        assert.isDefined(blocked);
        assert.include((blocked?.payload as { readonly reason: string }).reason, "ghost");
        assert.include(
          (blocked?.payload as { readonly reason: string }).reason,
          "no longer exists",
        );
      }),
  );
});

it.effect("editTicketMessage edits a free-standing user comment and rejects everything else", () =>
  Effect.gen(function* () {
    const providerResponses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const editLayer = baseLayer(
      makeStubStepExecutor({
        default: {
          _tag: "awaiting_user",
          waitingReason: "Which API should I use?",
          providerThreadId: "thread-ticket-edit" as never,
          providerRequestId: "request-ticket-edit" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-edit",
        } as never,
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(providerResponses, (calls) => [...calls, input]),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ticket-edit" as never, awaitingUserDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-ticket-edit" as never,
        title: "Edit me",
        initialLane: "impl" as never,
      });
      // Parking on the awaiting-user step posts an agent-authored message.
      const waitingDetail = yield* awaitStatus(ticketId as string, "waiting_on_user");
      const stepRunId = waitingDetail?.steps[0]?.stepRunId;
      assert.isString(stepRunId);
      const agentMessageId = waitingDetail?.messages.find((m) => m.author === "agent")?.messageId;
      assert.isString(agentMessageId);

      // Post a free-standing user comment (no stepRunId).
      yield* engine.postTicketMessage({
        ticketId,
        text: "original comment",
        attachments: [],
      });

      // Answer the awaiting step — this posts a user message that carries a stepRunId.
      yield* engine.answerTicketStep({
        stepRunId: stepRunId as never,
        text: "Use the sandbox endpoint.",
        attachments: [],
      });
      yield* awaitLane(ticketId as string, "done");

      const detailAfter = yield* read.getTicketDetail(ticketId);
      const freeStanding = detailAfter?.messages.find(
        (m) => m.author === "user" && m.stepRunId == null,
      );
      const stepBound = detailAfter?.messages.find(
        (m) => m.author === "user" && m.stepRunId != null,
      );
      assert.isString(freeStanding?.messageId);
      assert.isString(stepBound?.messageId);

      // Editing your own free-standing comment succeeds and stamps editedAt.
      yield* engine.editTicketMessage({
        ticketId,
        messageId: freeStanding?.messageId as never,
        body: "edited comment",
      });
      const detailEdited = yield* read.getTicketDetail(ticketId);
      const editedMessage = detailEdited?.messages.find(
        (m) => m.messageId === freeStanding?.messageId,
      );
      assert.equal(editedMessage?.body, "edited comment");
      assert.isNotNull(editedMessage?.editedAt);

      // Unknown messageId → message not found.
      const unknownExit = yield* engine
        .editTicketMessage({
          ticketId,
          messageId: "message-does-not-exist" as never,
          body: "nope",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(unknownExit));
      const unknownError = Exit.isFailure(unknownExit) ? Cause.squash(unknownExit.cause) : null;
      assert.instanceOf(unknownError, WorkflowEventStoreError);
      assert.match((unknownError as WorkflowEventStoreError).message, /message not found/);

      // Agent-authored message → cannot be edited.
      const agentExit = yield* engine
        .editTicketMessage({
          ticketId,
          messageId: agentMessageId as never,
          body: "rewriting the agent",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(agentExit));
      const agentError = Exit.isFailure(agentExit) ? Cause.squash(agentExit.cause) : null;
      assert.match(
        (agentError as WorkflowEventStoreError).message,
        /only your own comments can be edited/,
      );

      // User message bound to a step run → cannot be edited.
      const stepExit = yield* engine
        .editTicketMessage({
          ticketId,
          messageId: stepBound?.messageId as never,
          body: "rewriting the answer",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stepExit));
      const stepError = Exit.isFailure(stepExit) ? Cause.squash(stepExit.cause) : null;
      assert.match(
        (stepError as WorkflowEventStoreError).message,
        /only your own comments can be edited/,
      );

      // Empty body → rejected by validateTicketMessageInput.
      const emptyExit = yield* engine
        .editTicketMessage({
          ticketId,
          messageId: freeStanding?.messageId as never,
          body: "   ",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(emptyExit));
      const emptyError = Exit.isFailure(emptyExit) ? Cause.squash(emptyExit.cause) : null;
      assert.match(
        (emptyError as WorkflowEventStoreError).message,
        /requires text or an attachment/,
      );

      // Non-existent ticket → ticket not found.
      const ghostExit = yield* engine
        .editTicketMessage({
          ticketId: "ticket-does-not-exist" as never,
          messageId: freeStanding?.messageId as never,
          body: "into the void",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(ghostExit));
      const ghostError = Exit.isFailure(ghostExit) ? Cause.squash(ghostExit.cause) : null;
      assert.match((ghostError as WorkflowEventStoreError).message, /ticket not found/);
    }).pipe(Effect.provide(editLayer));
  }),
);
