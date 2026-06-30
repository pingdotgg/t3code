// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowTerminalRetentionSweeper } from "../Services/WorkflowTerminalRetentionSweeper.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { makeStubStepExecutor } from "./StubStepExecutor.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";
import { makeWorkflowTerminalRetentionSweeperLive } from "./WorkflowTerminalRetentionSweeper.ts";

// A board that threads every seam of the lifecycle in one definition:
//   triage (manual entry)  -- ticket is created here
//   impl   (auto entry)    -- its pipeline auto-runs to completion, then the
//                             lane `on.success` routes onward to `review`
//   review (manual entry)  -- an inbound external event (ci.passed/green)
//                             routes the ticket to the terminal `done` lane
//   done   (terminal)      -- carries a retention TTL so the terminal-retention
//                             sweep retires it
const lifecycleDefinition = {
  name: "lifecycle",
  lanes: [
    { key: "triage", name: "Triage", entry: "manual" },
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
      on: { success: "review", failure: "needs" },
    },
    {
      key: "review",
      name: "Review",
      entry: "manual",
      onEvent: [
        {
          name: "ci.passed",
          when: { "==": [{ var: "event.payload.status" }, "green"] },
          to: "done",
        },
      ],
    },
    { key: "needs", name: "Needs", entry: "manual" },
    {
      key: "done",
      name: "Done",
      entry: "manual",
      terminal: true,
      retention: "1 day",
    },
    // Negative-control lane: terminal but NO retention, so the sweep must never
    // pick tickets here (the sweeper only targets terminal lanes with a defined
    // retention — WorkflowTerminalRetentionSweeper.ts ~L173-186).
    { key: "archived", name: "Archived", entry: "manual", terminal: true },
  ],
};

// Engine stack identical in spirit to WorkflowEngine.concurrency.test.ts, with
// the terminal-retention sweeper layered on top. The sweeper depends only on
// services already present in the engine stack (WorkflowEngine, BoardRegistry,
// WorkflowEventStore, WorkflowReadModel, WorkflowBoardSaveLocks, SqlClient), so
// it composes cleanly without mocking any seam between create -> run -> route ->
// terminal -> retention.
//
// `nowMs` is pinned to a real 2026 instant. Under it.effect the TestClock is
// anchored at epoch 0, so the engine stamps `terminal_at` at ~1970; pinning the
// sweep clock to 2026 makes the terminal ticket older than its 1-day retention
// without needing TestClock.adjust (the sweeper reads `nowMs`, not the clock).
const lifecycleLayer = it.layer(
  makeWorkflowTerminalRetentionSweeperLive({
    sweepIntervalMs: 60_000,
    nowMs: Effect.succeed(Date.parse("2026-06-08T00:00:00.000Z")),
  }).pipe(
    Layer.provideMerge(WorkflowEngineLayer),
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(makeStubStepExecutor({ default: { _tag: "completed" } })),
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

const awaitLane = (ticketId: string, laneKey: string) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    let detail: TicketDetail | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = yield* read.getTicketDetail(ticketId as never);
      if (detail?.ticket.currentLaneKey === laneKey) {
        return detail;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    return detail;
  });

// NOTE: this is an ENGINE lifecycle integration test. The agent step's EXECUTION
// is stubbed (makeStubStepExecutor always returns `completed`), so it covers the
// engine's create -> route -> terminal -> retention seams threaded together, NOT
// the real step-executor / provider-dispatch path (covered by RealStepExecutor /
// ProviderDispatchOutbox tests). The value here is that the seams compose.
lifecycleLayer("WorkflowEngine lifecycle integration (stub step executor)", (it) => {
  it.effect(
    "threads create -> auto-run -> external-event route -> terminal -> retention sweep (with negative controls)",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const store = yield* WorkflowEventStore;
        const sweeper = yield* WorkflowTerminalRetentionSweeper;

        // 1. create a board
        yield* registry.register("b-lifecycle" as never, lifecycleDefinition);

        // 2. create a ticket on it (manual entry lane)
        const ticketId = yield* engine.createTicket({
          boardId: "b-lifecycle" as never,
          title: "Ship the thing",
          initialLane: "triage" as never,
        });
        assert.equal((yield* read.getTicketDetail(ticketId))?.ticket.currentLaneKey, "triage");

        // 2b. NEGATIVE CONTROLS — these must SURVIVE the sweep, proving the sweep
        //     deletes BECAUSE a ticket is terminal+expired+in-a-retention-lane, not
        //     indiscriminately. Without these, the test would pass even if the
        //     sweeper deleted every ticket it saw.
        //   - controlPending: never leaves the non-terminal triage lane.
        //   - controlArchived: terminal, but in the no-retention `archived` lane.
        const controlPending = yield* engine.createTicket({
          boardId: "b-lifecycle" as never,
          title: "Still in triage",
          initialLane: "triage" as never,
        });
        const controlArchived = yield* engine.createTicket({
          boardId: "b-lifecycle" as never,
          title: "Archived, no retention",
          initialLane: "triage" as never,
        });
        yield* engine.moveTicket(controlArchived as never, "archived" as never);
        assert.equal(
          (yield* read.getTicketDetail(controlArchived))?.ticket.currentLaneKey,
          "archived",
        );

        // 3. move it into the auto lane; its pipeline auto-runs to completion and
        //    the lane on.success routes it onward to `review`.
        yield* engine.moveTicket(ticketId as never, "impl" as never);
        const reviewDetail = yield* awaitLane(ticketId as string, "review");
        assert.equal(reviewDetail?.ticket.currentLaneKey, "review");
        assert.equal(
          reviewDetail?.steps.some(
            (step) => step.stepKey === "code" && step.status === "completed",
          ),
          true,
        );

        // 4. an inbound external/webhook event routes the ticket to the terminal lane.
        const moved = yield* engine.ingestExternalEvent({
          boardId: "b-lifecycle" as never,
          name: "ci.passed",
          ticketId,
          payload: { status: "green" },
        });
        assert.equal(moved.outcome, "moved");
        assert.equal(moved.toLane, "done");

        // 5. ticket reaches a TERMINAL lane.
        const doneDetail = yield* awaitLane(ticketId as string, "done");
        assert.equal(doneDetail?.ticket.currentLaneKey, "done");

        // The route to the terminal lane was recorded as an external-event decision.
        const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "TicketRouteDecided" &&
              event.payload.source === "external_event" &&
              event.payload.toLane === ("done" as string),
          ),
        );

        // 6. the terminal-retention sweep removes the terminal ticket.
        //    (nowMs is pinned past the 1-day retention vs the epoch-0 terminal_at.)
        const result = yield* sweeper.sweep();
        assert.equal(result.candidateCount, 1);
        assert.equal(result.deletedCount, 1);
        assert.equal(result.failedCount, 0);

        // The terminal+expired ticket and its detail are gone after the sweep.
        assert.equal(yield* read.getTicketDetail(ticketId), null);

        // The negative controls SURVIVE — the sweep was selective, not a blanket
        // delete: non-terminal ticket stays, terminal-but-no-retention ticket stays.
        assert.equal(
          (yield* read.getTicketDetail(controlPending))?.ticket.currentLaneKey,
          "triage",
        );
        assert.equal(
          (yield* read.getTicketDetail(controlArchived))?.ticket.currentLaneKey,
          "archived",
        );
      }),
  );
});
