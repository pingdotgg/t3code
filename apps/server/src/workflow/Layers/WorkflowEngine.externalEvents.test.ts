// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
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

const eventDefinition = {
  name: "events",
  lanes: [
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
        { name: "ci.failed", to: "work" },
      ],
    },
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
      on: { success: "review" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

layer("WorkflowEngine external events", (it) => {
  it.effect("moves a ticket when name and predicate match and records the decision", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-events" as never, eventDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-events" as never,
        title: "Ship it",
        initialLane: "review" as never,
      });

      // Wrong name: no-op.
      const wrongName = yield* engine.ingestExternalEvent({
        boardId: "b-events" as never,
        name: "deploy.finished",
        ticketId,
        payload: { status: "green" },
      });
      assert.equal(wrongName.outcome, "noop");

      // Matching name but failing predicate: no-op.
      const failingPredicate = yield* engine.ingestExternalEvent({
        boardId: "b-events" as never,
        name: "ci.passed",
        ticketId,
        payload: { status: "red" },
      });
      assert.equal(failingPredicate.outcome, "noop");

      const moved = yield* engine.ingestExternalEvent({
        boardId: "b-events" as never,
        name: "ci.passed",
        ticketId,
        payload: { status: "green" },
      });
      assert.equal(moved.outcome, "moved");
      assert.equal(moved.toLane, "done");

      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "done");

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const decision = events.find((event) => event.type === "TicketRouteDecided");
      assert.isDefined(decision);
      if (decision?.type === "TicketRouteDecided") {
        assert.equal(decision.payload.source, "external_event");
        assert.equal(decision.payload.toLane, "done");
      }
      const externalMove = events.find(
        (event) =>
          event.type === "TicketMovedToLane" &&
          event.payload.reason === "external" &&
          event.payload.toLane === ("done" as string),
      );
      assert.isDefined(externalMove);

      const decisions = yield* read.listTicketRouteDecisions(ticketId);
      const externalDecision = decisions.find((row) => row.source === "external_event");
      assert.equal(externalDecision?.eventName, "ci.passed");
      assert.equal(externalDecision?.toLane, "done");
    }),
  );

  it.effect("an event into an auto lane starts the pipeline", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-events-auto" as never, eventDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;

      const ticketId = yield* engine.createTicket({
        boardId: "b-events-auto" as never,
        title: "Send back",
        initialLane: "review" as never,
      });

      const moved = yield* engine.ingestExternalEvent({
        boardId: "b-events-auto" as never,
        name: "ci.failed",
        ticketId,
        payload: null,
      });
      assert.equal(moved.outcome, "moved");
      assert.equal(moved.toLane, "work");

      // The auto pipeline runs and routes onward to review.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const detail = yield* read.getTicketDetail(ticketId);
        if (detail?.ticket.currentLaneKey === "review") {
          return;
        }
        yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      }
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "review");
    }),
  );

  it.effect("rejects events for tickets on other boards", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-events-a" as never, eventDefinition);
      yield* registry.register("b-events-b" as never, eventDefinition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-events-a" as never,
        title: "Mine",
        initialLane: "review" as never,
      });

      const refused = yield* engine
        .ingestExternalEvent({
          boardId: "b-events-b" as never,
          name: "ci.passed",
          ticketId,
          payload: { status: "green" },
        })
        .pipe(Effect.flip);
      assert.include(refused.message, "not found");
    }),
  );
});

// Board definitions for pr.* predicate context tests.
const prCiGateDefinition = {
  name: "pr-ci-gate",
  lanes: [
    {
      key: "implement",
      name: "Implement",
      entry: "manual",
      onEvent: [
        {
          name: "pr.approved",
          when: { "==": [{ var: "pr.ciState" }, "success"] },
          to: "land",
        },
      ],
    },
    { key: "land", name: "Land", entry: "manual", terminal: true },
  ],
};

const prReviewGateDefinition = {
  name: "pr-review-gate",
  lanes: [
    {
      key: "implement",
      name: "Implement",
      entry: "manual",
      onEvent: [
        {
          name: "ci.passed",
          when: { "==": [{ var: "pr.reviewDecision" }, "approved"] },
          to: "land",
        },
      ],
    },
    { key: "land", name: "Land", entry: "manual", terminal: true },
  ],
};

layer("WorkflowEngine pr.* predicate context", (it) => {
  it.effect("pr.approved with pr.ciState=success moves the ticket; with pending stays noop", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-pr-ci-success" as never, prCiGateDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      const ticketId = yield* engine.createTicket({
        boardId: "b-pr-ci-success" as never,
        title: "My PR ticket",
        initialLane: "implement" as never,
      });

      // Seed workflow_pr_state with last_ci_state='success'
      yield* sql`
          INSERT INTO workflow_pr_state (
            ticket_id, pr_number, pr_url, branch, remote_name, repo,
            pr_state, last_ci_state, last_review_decision, updated_at
          ) VALUES (
            ${ticketId}, 42, 'https://github.com/o/r/pull/42',
            'workflow/my-ticket', 'origin', 'o/r',
            'open', 'success', 'none', '2026-06-12T00:00:00.000Z'
          )
        `;

      // Ingest pr.approved with ci passing → should move
      const moved = yield* engine.ingestExternalEvent({
        boardId: "b-pr-ci-success" as never,
        name: "pr.approved",
        ticketId,
        payload: null,
      });
      assert.equal(moved.outcome, "moved");
      assert.equal(moved.toLane, "land");

      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "land");
    }),
  );

  it.effect("pr.approved with pr.ciState=pending stays noop", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-pr-ci-pending" as never, prCiGateDefinition);
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;

      const ticketId = yield* engine.createTicket({
        boardId: "b-pr-ci-pending" as never,
        title: "Pending CI ticket",
        initialLane: "implement" as never,
      });

      // Seed workflow_pr_state with last_ci_state='pending'
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo,
          pr_state, last_ci_state, last_review_decision, updated_at
        ) VALUES (
          ${ticketId}, 43, 'https://github.com/o/r/pull/43',
          'workflow/pending-ticket', 'origin', 'o/r',
          'open', 'pending', 'none', '2026-06-12T00:00:00.000Z'
        )
      `;

      const noop = yield* engine.ingestExternalEvent({
        boardId: "b-pr-ci-pending" as never,
        name: "pr.approved",
        ticketId,
        payload: null,
      });
      assert.equal(noop.outcome, "noop");
    }),
  );

  it.effect("pr.approved with no workflow_pr_state row stays noop", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-pr-ci-norow" as never, prCiGateDefinition);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-pr-ci-norow" as never,
        title: "No PR row ticket",
        initialLane: "implement" as never,
      });

      // No workflow_pr_state row → pr.ciState is null → predicate fails
      const noop = yield* engine.ingestExternalEvent({
        boardId: "b-pr-ci-norow" as never,
        name: "pr.approved",
        ticketId,
        payload: null,
      });
      assert.equal(noop.outcome, "noop");
    }),
  );

  it.effect(
    "ci.passed with pr.reviewDecision=approved moves the ticket; with none stays noop",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-pr-review-approved" as never, prReviewGateDefinition);
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;

        const ticketId = yield* engine.createTicket({
          boardId: "b-pr-review-approved" as never,
          title: "Approved review ticket",
          initialLane: "implement" as never,
        });

        // Seed workflow_pr_state with last_review_decision='approved'
        yield* sql`
          INSERT INTO workflow_pr_state (
            ticket_id, pr_number, pr_url, branch, remote_name, repo,
            pr_state, last_ci_state, last_review_decision, updated_at
          ) VALUES (
            ${ticketId}, 44, 'https://github.com/o/r/pull/44',
            'workflow/review-ticket', 'origin', 'o/r',
            'open', 'success', 'approved', '2026-06-12T00:00:00.000Z'
          )
        `;

        // Ingest ci.passed with review approved → should move
        const moved = yield* engine.ingestExternalEvent({
          boardId: "b-pr-review-approved" as never,
          name: "ci.passed",
          ticketId,
          payload: null,
        });
        assert.equal(moved.outcome, "moved");
        assert.equal(moved.toLane, "land");

        const detail = yield* read.getTicketDetail(ticketId);
        assert.equal(detail?.ticket.currentLaneKey, "land");
      }),
  );

  it.effect("ci.passed with pr.reviewDecision=none stays noop", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-pr-review-none" as never, prReviewGateDefinition);
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;

      const ticketId = yield* engine.createTicket({
        boardId: "b-pr-review-none" as never,
        title: "None review ticket",
        initialLane: "implement" as never,
      });

      // Seed workflow_pr_state with last_review_decision='none'
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo,
          pr_state, last_ci_state, last_review_decision, updated_at
        ) VALUES (
          ${ticketId}, 45, 'https://github.com/o/r/pull/45',
          'workflow/none-review-ticket', 'origin', 'o/r',
          'open', 'pending', 'none', '2026-06-12T00:00:00.000Z'
        )
      `;

      const noop = yield* engine.ingestExternalEvent({
        boardId: "b-pr-review-none" as never,
        name: "ci.passed",
        ticketId,
        payload: null,
      });
      assert.equal(noop.outcome, "noop");
    }),
  );

  it.effect("flows pr context (ciState + reviewDecision) through to predicate evaluation", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-pr-context-flow" as never, prCiGateDefinition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      const ticketId = yield* engine.createTicket({
        boardId: "b-pr-context-flow" as never,
        title: "Context flow ticket",
        initialLane: "implement" as never,
      });

      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo,
          pr_state, last_ci_state, last_review_decision, updated_at
        ) VALUES (
          ${ticketId}, 46, 'https://github.com/o/r/pull/46',
          'workflow/context-flow', 'origin', 'o/r',
          'open', 'success', 'approved', '2026-06-12T00:00:00.000Z'
        )
      `;

      // Sanity-check the seeded state the engine will read.
      const prStateRow = yield* read.getTicketPrState(ticketId);
      assert.equal(prStateRow?.lastCiState, "success");
      assert.equal(prStateRow?.lastReviewDecision, "approved");

      // The engine reads workflow_pr_state once and exposes pr.ciState /
      // pr.reviewDecision to the onEvent.when predicate. The single-read property
      // (engine reads pr state once before resolveTarget; revalidate reuses that
      // snapshot instead of re-reading) is enforced structurally in
      // WorkflowEngine.ts — see the comment at the getTicketPrState call site.
      const moved = yield* engine.ingestExternalEvent({
        boardId: "b-pr-context-flow" as never,
        name: "pr.approved",
        ticketId,
        payload: null,
      });
      assert.equal(moved.outcome, "moved");
      assert.equal(moved.toLane, "land");
    }),
  );
});
