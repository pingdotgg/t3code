// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import type { StepOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
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

interface RecordedCall {
  readonly stepKey: string;
  readonly model: string | null;
  readonly instance: string | null;
  readonly optionIds: ReadonlyArray<string>;
}

interface ScriptedExecutor {
  readonly calls: Array<RecordedCall>;
  readonly layer: Layer.Layer<StepExecutor>;
}

const makeScriptedExecutor = (outcomeForCall: (call: number) => StepOutcome): ScriptedExecutor => {
  const calls: Array<RecordedCall> = [];
  const layer = Layer.succeed(StepExecutor, {
    execute: (ctx) =>
      Effect.sync(() => {
        const step = ctx.step;
        calls.push({
          stepKey: step.key as string,
          model: step.type === "agent" ? (step.agent.model as string) : null,
          instance: step.type === "agent" ? (step.agent.instance as string) : null,
          optionIds:
            step.type === "agent" ? (step.agent.options ?? []).map((o) => o.id as string) : [],
        });
        return outcomeForCall(calls.length);
      }),
  } satisfies StepExecutorShape);
  return { calls, layer };
};

const baseLayer = (executor: Layer.Layer<StepExecutor>) =>
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

const awaitLane = (ticketId: string, laneKey: string) =>
  awaitTicketWhere(ticketId, (detail) => detail?.ticket.currentLaneKey === laneKey);

const retryDefinition = (retry: unknown) => ({
  name: "retry-wf",
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
          retry,
        },
      ],
      on: { success: "done", failure: "needs" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
});

const flakyExecutor = makeScriptedExecutor((call) =>
  call < 3 ? { _tag: "failed", error: `boom ${call}` } : { _tag: "completed" },
);

const flakyLayer = it.layer(baseLayer(flakyExecutor.layer));

flakyLayer("retry with escalation succeeds on a later attempt", (it) => {
  it.effect("re-runs failed agent steps with the escalated selection", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-retry" as never,
        retryDefinition({
          maxAttempts: 3,
          escalate: { model: "opus", options: [{ id: "effort", value: "high" }] },
        }) as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-retry" as never,
        title: "Flaky work",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "done");
      assert.equal(detail?.ticket.currentLaneKey, "done");

      assert.equal(flakyExecutor.calls.length, 3);
      assert.deepEqual(
        flakyExecutor.calls.map((call) => call.model),
        ["sonnet", "opus", "opus"],
      );
      assert.deepEqual(flakyExecutor.calls[1]?.optionIds, ["effort"]);

      const codeRuns = (detail?.steps ?? []).filter((step) => step.stepKey === "code");
      assert.equal(codeRuns.length, 3);
      assert.deepEqual(
        codeRuns.map((step) => step.attempt),
        [1, 2, 3],
      );
      assert.deepEqual(
        codeRuns.map((step) => step.status),
        ["failed", "failed", "completed"],
      );
    }),
  );
});

const alwaysFailExecutor = makeScriptedExecutor((call) => ({
  _tag: "failed",
  error: `boom ${call}`,
}));

const exhaustedLayer = it.layer(baseLayer(alwaysFailExecutor.layer));

exhaustedLayer("retry exhaustion routes the final failure", (it) => {
  it.effect("stops after maxAttempts and routes to the failure lane", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-exhaust" as never, retryDefinition({ maxAttempts: 2 }) as never);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-exhaust" as never,
        title: "Hopeless work",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(alwaysFailExecutor.calls.length, 2);
      assert.deepEqual(
        (detail?.steps ?? []).map((step) => step.status),
        ["failed", "failed"],
      );
    }),
  );
});

const blockedExecutor = makeScriptedExecutor(() => ({ _tag: "blocked", reason: "no trust" }));

const blockedLayer = it.layer(baseLayer(blockedExecutor.layer));

blockedLayer("blocked outcomes never retry", (it) => {
  it.effect("runs the step exactly once", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-blocked" as never,
        {
          ...retryDefinition({ maxAttempts: 3 }),
          lanes: retryDefinition({ maxAttempts: 3 }).lanes.map((lane) =>
            lane.key === "impl" ? { ...lane, on: { ...lane.on, blocked: "needs" } } : lane,
          ),
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-blocked" as never,
        title: "Blocked work",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(blockedExecutor.calls.length, 1);
    }),
  );
});

const awaitingExecutor = makeScriptedExecutor(() => ({
  _tag: "awaiting_user",
  waitingReason: "Need a decision",
}));

const rejectionLayer = it.layer(baseLayer(awaitingExecutor.layer));

rejectionLayer("user rejections never retry", (it) => {
  it.effect("a rejected awaiting-user step fails without another attempt", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-reject" as never, retryDefinition({ maxAttempts: 3 }) as never);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-reject" as never,
        title: "Risky work",
        initialLane: "impl" as never,
      });

      const waiting = yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.status === "waiting_on_user",
      );
      const stepRunId = waiting?.steps[0]?.stepRunId;
      assert.ok(stepRunId !== undefined);

      yield* engine.resolveApproval(stepRunId as never, false);

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(awaitingExecutor.calls.length, 1);
      assert.deepEqual(
        (detail?.steps ?? []).map((step) => step.status),
        ["failed"],
      );
    }),
  );
});

const cancelledExecutor = makeScriptedExecutor((call) => ({
  _tag: "failed",
  error: `cancelled ${call}`,
  retryable: false,
}));

const cancelledLayer = it.layer(baseLayer(cancelledExecutor.layer));

cancelledLayer("non-retryable failures never retry", (it) => {
  it.effect("a cancelled step fails without another attempt", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-cancelled" as never,
        retryDefinition({ maxAttempts: 3 }) as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-cancelled" as never,
        title: "Cancelled work",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(cancelledExecutor.calls.length, 1);
    }),
  );
});

const recoveryExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));

const recoveryLayer = it.layer(baseLayer(recoveryExecutor.layer));

recoveryLayer("recovered failed attempts resume the retry loop", (it) => {
  it.effect("a failed attempt recovered after restart consumes its remaining attempts", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover" as never,
        retryDefinition({ maxAttempts: 2, escalate: { model: "opus" } }) as never,
      );
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;

      const seed = (event: Record<string, unknown>, eventId: string) =>
        committer.commit({
          ...event,
          eventId,
          occurredAt: "1969-12-31T00:00:00.000Z",
        } as never);

      yield* seed(
        {
          type: "TicketCreated",
          ticketId: "t-recover",
          payload: { boardId: "b-recover", title: "Restarted work", laneKey: "impl" },
        },
        "evt-rec-created",
      );
      yield* seed(
        {
          type: "TicketMovedToLane",
          ticketId: "t-recover",
          payload: { toLane: "impl", laneEntryToken: "tok-rec", reason: "initial" },
        },
        "evt-rec-moved",
      );
      yield* seed(
        {
          type: "PipelineStarted",
          ticketId: "t-recover",
          payload: { pipelineRunId: "pipe-rec", laneKey: "impl", laneEntryToken: "tok-rec" },
        },
        "evt-rec-pipe",
      );
      yield* seed(
        {
          type: "StepStarted",
          ticketId: "t-recover",
          payload: {
            pipelineRunId: "pipe-rec",
            stepRunId: "step-rec-1",
            stepKey: "code",
            stepType: "agent",
            attempt: 1,
          },
        },
        "evt-rec-step",
      );

      yield* engine.completeRecoveredStep("step-rec-1" as never, {
        _tag: "failed",
        error: "interrupted",
      });

      const detail = yield* awaitLane("t-recover", "done");
      assert.equal(detail?.ticket.currentLaneKey, "done");
      // The recovered failure consumed attempt 1; the engine ran attempt 2
      // with the escalated selection and routed the success.
      assert.equal(recoveryExecutor.calls.length, 1);
      assert.equal(recoveryExecutor.calls[0]?.model, "opus");
      const codeRuns = (detail?.steps ?? []).filter((step) => step.stepKey === "code");
      assert.deepEqual(
        codeRuns.map((step) => [step.attempt, step.status]),
        [
          [1, "failed"],
          [2, "completed"],
        ],
      );
    }),
  );
});

const recoveredCancelExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));

const recoveredCancelLayer = it.layer(baseLayer(recoveredCancelExecutor.layer));

recoveredCancelLayer("recovered non-retryable failures never retry", (it) => {
  it.effect("a recovered cancellation routes the failure without new attempts", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-cancel" as never,
        retryDefinition({ maxAttempts: 3 }) as never,
      );
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;

      const seed = (event: Record<string, unknown>, eventId: string) =>
        committer.commit({
          ...event,
          eventId,
          occurredAt: "1969-12-31T00:00:00.000Z",
        } as never);

      yield* seed(
        {
          type: "TicketCreated",
          ticketId: "t-recover-cancel",
          payload: { boardId: "b-recover-cancel", title: "Cancelled work", laneKey: "impl" },
        },
        "evt-rc-created",
      );
      yield* seed(
        {
          type: "TicketMovedToLane",
          ticketId: "t-recover-cancel",
          payload: { toLane: "impl", laneEntryToken: "tok-rc", reason: "initial" },
        },
        "evt-rc-moved",
      );
      yield* seed(
        {
          type: "PipelineStarted",
          ticketId: "t-recover-cancel",
          payload: { pipelineRunId: "pipe-rc", laneKey: "impl", laneEntryToken: "tok-rc" },
        },
        "evt-rc-pipe",
      );
      yield* seed(
        {
          type: "StepStarted",
          ticketId: "t-recover-cancel",
          payload: {
            pipelineRunId: "pipe-rc",
            stepRunId: "step-rc-1",
            stepKey: "code",
            stepType: "script",
            attempt: 1,
          },
        },
        "evt-rc-step",
      );

      yield* engine.completeRecoveredStep("step-rc-1" as never, {
        _tag: "failed",
        error: "script cancelled",
        retryable: false,
      });

      const detail = yield* awaitLane("t-recover-cancel", "needs");
      assert.equal(detail?.ticket.currentLaneKey, "needs");
      assert.equal(recoveredCancelExecutor.calls.length, 0);
    }),
  );
});

const loopDefinition = {
  name: "loop-wf",
  lanes: [
    {
      key: "implementation",
      name: "Implementation",
      entry: "auto",
      pipeline: [
        {
          key: "implement",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "implement",
        },
        {
          key: "review",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "review",
          captureOutput: true,
        },
      ],
      transitions: [
        {
          when: {
            and: [
              { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
              { "<": [{ var: "lane.runCount" }, 3] },
            ],
          },
          to: "implementation",
        },
        {
          when: { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
          to: "manual_review",
        },
        {
          when: { "==": [{ var: "steps.review.output.verdict" }, "approve"] },
          to: "owner_review",
        },
      ],
      on: { success: "owner_review", failure: "needs", blocked: "needs" },
    },
    { key: "owner_review", name: "Owner Review", entry: "manual" },
    { key: "manual_review", name: "Manual Review", entry: "manual" },
    { key: "needs", name: "Needs", entry: "manual" },
  ],
};

const reviewLoopExecutor = makeScriptedExecutor((call) => {
  // Calls alternate implement/review per lane run: 1=impl 2=review(revise)
  // 3=impl 4=review(approve).
  if (call % 2 === 1) {
    return { _tag: "completed" };
  }
  return { _tag: "completed", output: { verdict: call < 4 ? "revise" : "approve" } };
});

const reviewLoopLayer = it.layer(baseLayer(reviewLoopExecutor.layer));

reviewLoopLayer("lane.runCount bounds the review loop", (it) => {
  it.effect("revise re-enters the lane and approve routes onward", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-loop" as never, loopDefinition as never);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-loop" as never,
        title: "Loop work",
        initialLane: "implementation" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "owner_review");
      assert.equal(detail?.ticket.currentLaneKey, "owner_review");
      // Two full lane runs: implement+review, then implement+review again.
      assert.equal(reviewLoopExecutor.calls.length, 4);
      const reviewRuns = (detail?.steps ?? []).filter((step) => step.stepKey === "review");
      assert.equal(reviewRuns.length, 2);
    }),
  );
});

const exhaustedLoopExecutor = makeScriptedExecutor((call) =>
  call % 2 === 1 ? { _tag: "completed" } : { _tag: "completed", output: { verdict: "revise" } },
);

const exhaustedLoopLayer = it.layer(baseLayer(exhaustedLoopExecutor.layer));

exhaustedLoopLayer("review loop budget exhausts to manual review", (it) => {
  it.effect("a persistently revised ticket escalates after three lane runs", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-loop-exhaust" as never, loopDefinition as never);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-loop-exhaust" as never,
        title: "Stubborn work",
        initialLane: "implementation" as never,
      });

      const detail = yield* awaitLane(ticketId as string, "manual_review");
      assert.equal(detail?.ticket.currentLaneKey, "manual_review");
      // Three lane runs of implement+review before escalation.
      assert.equal(exhaustedLoopExecutor.calls.length, 6);

      // A manual move back into the lane is a human intervention: the loop
      // budget resets and the ticket gets three fresh passes.
      yield* engine.moveTicket(ticketId, "implementation" as never);
      const second = yield* awaitTicketWhere(
        ticketId as string,
        (current) =>
          current?.ticket.currentLaneKey === "manual_review" && (current.steps?.length ?? 0) >= 12,
      );
      assert.equal(second?.ticket.currentLaneKey, "manual_review");
      assert.equal(exhaustedLoopExecutor.calls.length, 12);
    }),
  );
});

const commentExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const commentLayer = it.layer(baseLayer(commentExecutor.layer));

commentLayer("postTicketMessage", (it) => {
  it.effect("posts a user comment without an awaiting step", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-comment" as never, retryDefinition({ maxAttempts: 2 }) as never);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-comment" as never,
        title: "Comment target",
        initialLane: "needs" as never,
      });

      yield* engine.postTicketMessage({ ticketId, text: "Note to self: check auth flow." });

      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.messages.length, 1);
      assert.equal(detail?.messages[0]?.author, "user");
      assert.equal(detail?.messages[0]?.body, "Note to self: check auth flow.");
      assert.equal(detail?.messages[0]?.stepRunId, null);

      const empty = yield* Effect.exit(engine.postTicketMessage({ ticketId, text: "   " }));
      assert.equal(empty._tag, "Failure");

      const missing = yield* Effect.exit(
        engine.postTicketMessage({ ticketId: "nope" as never, text: "hello" }),
      );
      assert.equal(missing._tag, "Failure");
    }),
  );
});
