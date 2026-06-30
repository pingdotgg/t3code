import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ApprovalGate } from "../Services/ApprovalGate.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { DurableApprovalResume } from "../Services/DurableApprovalResume.ts";
import { ProviderResponsePort } from "../Services/ProviderResponsePort.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { DurableApprovalResumeLive } from "./DurableApprovalResume.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const eventStoreLayer = WorkflowEventStoreLive.pipe(
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("parks unresolved workflow approval waits during recovery", () =>
  Effect.gen(function* () {
    const parked = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = DurableApprovalResumeLive.pipe(
      Layer.provideMerge(eventStoreLayer),
      Layer.provideMerge(
        Layer.succeed(ApprovalGate, {
          await: () => Effect.die("unused"),
          resolve: () => Effect.succeed(false),
          park: (stepRunId) =>
            Ref.update(parked, (ids) => [...ids, stepRunId as string]).pipe(Effect.asVoid),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const resume = yield* DurableApprovalResume;
      yield* store.append({
        type: "StepAwaitingUser",
        eventId: "evt-await" as never,
        ticketId: "ticket-1" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: { stepRunId: "step-run-1" as never, waitingReason: "Approve?" },
      });

      yield* resume.resume();

      assert.deepEqual(yield* Ref.get(parked), ["step-run-1"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("resets provider-backed waits and clears stale projected turns during recovery", () =>
  Effect.gen(function* () {
    const parked = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = DurableApprovalResumeLive.pipe(
      Layer.provideMerge(eventStoreLayer),
      Layer.provideMerge(
        Layer.succeed(ApprovalGate, {
          await: () => Effect.die("unused"),
          resolve: () => Effect.succeed(false),
          park: (stepRunId) =>
            Ref.update(parked, (ids) => [...ids, stepRunId as string]).pipe(Effect.asVoid),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const resume = yield* DurableApprovalResume;
      const sql = yield* SqlClient.SqlClient;
      yield* store.append({
        type: "StepAwaitingUser",
        eventId: "evt-provider-await-stale" as never,
        ticketId: "ticket-provider-stale" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          stepRunId: "step-run-provider-stale" as never,
          waitingReason: "Provider is waiting for user input",
          providerThreadId: "thread-provider-stale" as never,
          providerRequestId: "request-provider-stale" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-provider-stale",
        },
      });
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
          'dispatch-provider-stale',
          'ticket-provider-stale',
          'step-run-provider-stale',
          'thread-provider-stale',
          'codex',
          'gpt-5.5',
          'ask again',
          '/tmp/provider-stale',
          'started',
          'turn-provider-stale',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:01.000Z'
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
          'thread-provider-stale',
          'turn-provider-stale',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:01.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      yield* resume.resume();

      const dispatchRows = yield* sql<{
        readonly status: string;
        readonly turnId: string | null;
        readonly startedAt: string | null;
      }>`
        SELECT
          status,
          turn_id AS "turnId",
          started_at AS "startedAt"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-provider-stale'
      `;
      assert.deepEqual(dispatchRows[0], {
        status: "pending",
        turnId: null,
        startedAt: null,
      });

      const turnRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = 'thread-provider-stale'
          AND turn_id = 'turn-provider-stale'
      `;
      assert.equal(turnRows[0]?.state, "interrupted");
      assert.isString(turnRows[0]?.completedAt);
      assert.deepEqual(yield* Ref.get(parked), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("routes provider-question approval resolution to the provider response port", () =>
  Effect.gen(function* () {
    const responses = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = WorkflowEngineLayer.pipe(
      Layer.provideMerge(eventStoreLayer),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(responses, (values) => [...values, input]),
        }),
      ),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(ApprovalGate, {
          await: () => Effect.die("unused"),
          resolve: () => Effect.succeed(false),
          park: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowEventCommitter, {
          commit: () => Effect.void,
          commitMany: () => Effect.void,
          appendManyUnlocked: () => Effect.succeed([]),
          publishTicketView: () => Effect.void,
        }),
      ),
      Layer.provideMerge(Layer.succeed(StepExecutor, { execute: () => Effect.die("unused") })),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowRoutingContextBuilderLive),
      Layer.provideMerge(
        Layer.succeed(WorkflowReadModel, {
          registerBoard: () => Effect.void,
          getBoard: () => Effect.succeed(null),
          deleteBoard: () => Effect.void,
          deleteBoardTicketState: () => Effect.void,
          deleteTicketState: () => Effect.void,
          listBoardsForProject: () => Effect.succeed([]),
          listTickets: () => Effect.succeed([]),
          countAdmittedInLane: () => Effect.succeed(0),
          oldestQueuedForLane: () => Effect.succeed(null),
          getTicketDetail: () => Effect.succeed(null),
          listTicketMessages: () => Effect.succeed([]),
          listStepRunsForPipeline: () => Effect.succeed([]),
          countLanePipelineRuns: () => Effect.succeed(1),
          listTicketDiscussion: () => Effect.succeed([]),
          listReleasableDependents: () => Effect.succeed([]),
          getBoardDigest: () =>
            Effect.succeed({
              windowHours: 24,
              createdCount: 0,
              shippedCount: 0,
              totalTokens: 0,
              totalDurationMs: 0,
              needsAttention: [],
            }),
          getBoardMetrics: () =>
            Effect.succeed({
              windowDays: 7,
              generatedAt: "2026-06-07T00:00:00.000Z",
              throughput: { created: 0, shipped: 0 },
              cycleTime: { count: 0, p50Ms: 0, p90Ms: 0, avgMs: 0 },
              wipByLane: [],
              statusBreakdown: {},
              attention: { blocked: 0, waitingOnUser: 0, oldest: [] },
              routeOutcomes: [],
              manualMoveCount: 0,
              stepStats: [],
            }),
          listDependentTicketIds: () => Effect.succeed([]),
          listNeedsAttentionTickets: () => Effect.succeed([]),
          listTicketRouteDecisions: () => Effect.succeed([]),
          getTicketPrState: () => Effect.succeed(null),
          recordBoardProposal: () => Effect.void,
          listBoardProposals: () => Effect.succeed([]),
          getBoardProposal: () => Effect.succeed(null),
          listLiveOccupiedLanes: () => Effect.succeed([]),
          resolveBoardProposalStatus: () => Effect.succeed(1),
          listWorkSourceMappingsForBoard: () => Effect.succeed([]),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(BoardRegistry, {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        }),
      ),
      Layer.provideMerge(DeterministicWorkflowIds),
    );

    yield* Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const engine = yield* WorkflowEngine;
      yield* store.append({
        type: "StepAwaitingUser",
        eventId: "evt-provider-await" as never,
        ticketId: "ticket-provider" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          stepRunId: "step-run-provider" as never,
          waitingReason: "Provider needs approval",
          providerThreadId: "thread-provider" as never,
          providerRequestId: "request-provider" as never,
          providerResponseKind: "request",
        },
      });

      yield* engine.resolveApproval("step-run-provider" as never, true);

      assert.deepEqual(yield* Ref.get(responses), [
        {
          threadId: "thread-provider",
          requestId: "request-provider",
          responseKind: "request",
          approved: true,
        },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("rejects resolveApproval for provider user-input waits without responding", () =>
  Effect.gen(function* () {
    const responses = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = WorkflowEngineLayer.pipe(
      Layer.provideMerge(eventStoreLayer),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderResponsePort, {
          respond: (input) => Ref.update(responses, (values) => [...values, input]),
        }),
      ),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(ApprovalGate, {
          await: () => Effect.die("unused"),
          resolve: () => Effect.succeed(false),
          park: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowEventCommitter, {
          commit: () => Effect.void,
          commitMany: () => Effect.void,
          appendManyUnlocked: () => Effect.succeed([]),
          publishTicketView: () => Effect.void,
        }),
      ),
      Layer.provideMerge(Layer.succeed(StepExecutor, { execute: () => Effect.die("unused") })),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowRoutingContextBuilderLive),
      Layer.provideMerge(
        Layer.succeed(WorkflowReadModel, {
          registerBoard: () => Effect.void,
          getBoard: () => Effect.succeed(null),
          deleteBoard: () => Effect.void,
          deleteBoardTicketState: () => Effect.void,
          deleteTicketState: () => Effect.void,
          listBoardsForProject: () => Effect.succeed([]),
          listTickets: () => Effect.succeed([]),
          countAdmittedInLane: () => Effect.succeed(0),
          oldestQueuedForLane: () => Effect.succeed(null),
          getTicketDetail: () => Effect.succeed(null),
          listTicketMessages: () => Effect.succeed([]),
          listStepRunsForPipeline: () => Effect.succeed([]),
          countLanePipelineRuns: () => Effect.succeed(1),
          listTicketDiscussion: () => Effect.succeed([]),
          listReleasableDependents: () => Effect.succeed([]),
          getBoardDigest: () =>
            Effect.succeed({
              windowHours: 24,
              createdCount: 0,
              shippedCount: 0,
              totalTokens: 0,
              totalDurationMs: 0,
              needsAttention: [],
            }),
          getBoardMetrics: () =>
            Effect.succeed({
              windowDays: 7,
              generatedAt: "2026-06-07T00:00:00.000Z",
              throughput: { created: 0, shipped: 0 },
              cycleTime: { count: 0, p50Ms: 0, p90Ms: 0, avgMs: 0 },
              wipByLane: [],
              statusBreakdown: {},
              attention: { blocked: 0, waitingOnUser: 0, oldest: [] },
              routeOutcomes: [],
              manualMoveCount: 0,
              stepStats: [],
            }),
          listDependentTicketIds: () => Effect.succeed([]),
          listNeedsAttentionTickets: () => Effect.succeed([]),
          listTicketRouteDecisions: () => Effect.succeed([]),
          getTicketPrState: () => Effect.succeed(null),
          recordBoardProposal: () => Effect.void,
          listBoardProposals: () => Effect.succeed([]),
          getBoardProposal: () => Effect.succeed(null),
          listLiveOccupiedLanes: () => Effect.succeed([]),
          resolveBoardProposalStatus: () => Effect.succeed(1),
          listWorkSourceMappingsForBoard: () => Effect.succeed([]),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(BoardRegistry, {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        }),
      ),
      Layer.provideMerge(DeterministicWorkflowIds),
    );

    yield* Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const engine = yield* WorkflowEngine;
      yield* store.append({
        type: "StepAwaitingUser",
        eventId: "evt-provider-user-input-await" as never,
        ticketId: "ticket-provider-user-input" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          stepRunId: "step-run-provider-user-input" as never,
          waitingReason: "Which API should I use?",
          providerThreadId: "thread-provider-user-input" as never,
          providerRequestId: "request-provider-user-input" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-provider-user-input",
        },
      });

      const error = yield* Effect.flip(
        engine.resolveApproval("step-run-provider-user-input" as never, true),
      );

      assert.include(error.message, "answerTicketStep");
      assert.deepEqual(yield* Ref.get(responses), []);
    }).pipe(Effect.provide(layer));
  }),
);
