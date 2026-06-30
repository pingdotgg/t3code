// @effect-diagnostics globalTimers:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { WorkflowRpcError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { DurableApprovalResumeLive } from "./DurableApprovalResume.ts";
import { ProviderDispatchOutboxLive } from "./ProviderDispatchOutbox.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { ProviderTurnPort } from "../Services/ProviderDispatchOutbox.ts";
import {
  ProviderResponsePort,
  type ProviderResponseInput,
} from "../Services/ProviderResponsePort.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import {
  WorkflowEventCommitter,
  type WorkflowEventCommitterShape,
} from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowFileLoader } from "../Services/WorkflowFileLoader.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowRecovery } from "../Services/WorkflowRecovery.ts";
import { WorktreeLeaseServiceLive } from "./WorktreeLeaseService.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { GitHubPort, type GitHubPortShape } from "../Services/GitHubPort.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRecoveryLive } from "./WorkflowRecovery.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const completedRecoveredSteps: Array<{
  readonly stepRunId: string;
  readonly result: unknown;
  readonly captureTurn?: unknown;
}> = [];
let recoveryEventId = 0;
const loadedRecoveryBoards: string[] = [];
let recoveryStepExecutions = 0;
let delayedPipelineStartRelease: Deferred.Deferred<void> | null = null;
let delayedPipelineStartAttempts = 0;

// Mutable GitHub port double for PR recovery tests. Reset per test.
const gitHubPortScript: {
  findPrForBranch: { number: number; url: string } | null;
  prDetailState: "open" | "merged" | "closed";
  findPrForBranchCalls: number;
} = {
  findPrForBranch: null,
  prDetailState: "open",
  findPrForBranchCalls: 0,
};

const RecoveryGitHubPortLayer = Layer.succeed(GitHubPort, {
  resolveRemote: () => Effect.succeed({ remoteName: "origin", repo: "acme/widgets" }),
  findPrForBranch: () =>
    Effect.sync(() => {
      gitHubPortScript.findPrForBranchCalls += 1;
      return gitHubPortScript.findPrForBranch;
    }),
  prDetail: (input: { prNumber: number }) =>
    Effect.succeed({
      number: input.prNumber,
      url: `https://github.com/acme/widgets/pull/${input.prNumber}`,
      state: gitHubPortScript.prDetailState,
      headSha: null,
      reviewDecision: "none" as const,
      ciState: "success" as const,
    }),
} as unknown as GitHubPortShape);

const recoveryPreloadFileSystem = FileSystem.layerNoop({
  exists: () => Effect.succeed(true),
});

const recoveryPreloadSupport = Layer.mergeAll(
  WorkflowFoundationLive,
  NodeServices.layer,
  recoveryPreloadFileSystem,
);

const layer = it.layer(
  WorkflowRecoveryLive.pipe(
    Layer.provideMerge(ProviderDispatchOutboxLive),
    Layer.provideMerge(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TurnStateReader, {
        read: () => Effect.succeed({ _tag: "completed" as const }),
      }),
    ),
    Layer.provideMerge(DurableApprovalResumeLive),
    Layer.provideMerge(WorktreeLeaseServiceLive),
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(
      Layer.succeed(WorkflowFileLoader, {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) => Effect.succeed(input.boardId),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectWorkspaceResolver, {
        resolve: () => Effect.succeed("/tmp/recovery-project"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowEngine, {
        createTicket: () => Effect.die("unused createTicket"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.die("unused moveTicket"),
        createTicketAndEnterUnlocked: () => Effect.die("unused createTicketAndEnterUnlocked"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
        supersedeProviderWorkForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
        terminalAgentSessionThreadsForTicket: () =>
          Effect.die("unused closeTicketFromSourceUnlocked"),
        stopAgentSessionsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
        editTicketFieldsUnlocked: () => Effect.die("unused editTicketFieldsUnlocked"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.die("unused runLane"),
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.die("unused resolveApproval"),
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.die("unused cancelStep"),
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: (stepRunId, result, captureTurn) =>
          Effect.sync(() => {
            completedRecoveredSteps.push({
              stepRunId,
              result,
              ...(captureTurn === undefined ? {} : { captureTurn }),
            });
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowIds, {
        ticketId: () => Effect.succeed("ticket-unused" as never),
        pipelineRunId: () => Effect.succeed("pipeline-unused" as never),
        scriptRunId: () => Effect.succeed("script-unused" as never),
        stepRunId: () => Effect.succeed("step-unused" as never),
        messageId: () => Effect.succeed("message-unused" as never),
        eventId: () =>
          Effect.sync(() => {
            recoveryEventId += 1;
            return `evt-recovery-${recoveryEventId}` as never;
          }),
        token: () => Effect.succeed("token-unused" as never),
        mappingId: () => Effect.succeed("mapping-unused" as never),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TurnStateReader, {
        read: () => Effect.succeed({ _tag: "completed" as const }),
      }),
    ),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(RecoveryGitHubPortLayer),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(recoveryPreloadSupport),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const recoveryWipDefinition = {
  name: "recovery wip",
  lanes: [
    {
      key: "queue",
      name: "Queue",
      entry: "auto",
      wipLimit: 1,
      pipeline: [
        {
          key: "queue-step",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "recover queued",
        },
      ],
    },
    {
      key: "stranded",
      name: "Stranded",
      entry: "auto",
      wipLimit: 1,
      pipeline: [
        {
          key: "stranded-step",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "recover stranded",
        },
      ],
    },
  ],
};
const recoveryDefinitions = new Map<string, typeof recoveryWipDefinition>();

const recoveryWipExecutor = Layer.succeed(StepExecutor, {
  execute: () =>
    Effect.sync(() => {
      recoveryStepExecutions += 1;
      return { _tag: "failed" as const, error: "recovered pipeline holds its slot" };
    }),
} satisfies StepExecutorShape);

const recoveryBoardRegistry = Layer.succeed(BoardRegistry, {
  register: (boardId, definition) =>
    Effect.sync(() => {
      recoveryDefinitions.set(boardId as string, definition as typeof recoveryWipDefinition);
      return definition as never;
    }),
  unregister: (boardId) =>
    Effect.sync(() => {
      recoveryDefinitions.delete(boardId as string);
    }),
  getDefinition: (boardId) =>
    Effect.succeed((recoveryDefinitions.get(boardId as string) ?? null) as never),
  listDefinitions: () =>
    Effect.succeed(
      Array.from(recoveryDefinitions.entries(), ([boardId, definition]) => ({
        boardId: boardId as never,
        definition: definition as never,
      })),
    ),
  getLane: (boardId, laneKey) =>
    Effect.succeed(
      (recoveryDefinitions.get(boardId as string)?.lanes.find((lane) => lane.key === laneKey) ??
        null) as never,
    ),
});

const recoveryWipFileLoader = Layer.succeed(WorkflowFileLoader, {
  lintDefinition: () => Effect.succeed([]),
  loadAndRegister: (input) =>
    Effect.sync(() => {
      loadedRecoveryBoards.push(input.boardId as string);
      recoveryDefinitions.set(input.boardId as string, recoveryWipDefinition);
      return input.boardId;
    }),
});

const isWorkflowEventStoreError = Schema.is(WorkflowEventStoreError);
const toDelayedCommitterError = (cause: unknown) =>
  isWorkflowEventStoreError(cause)
    ? cause
    : new WorkflowEventStoreError({ message: "delayed workflow commit transaction failed", cause });

const delayedPipelineStartCommitter = Layer.effect(
  WorkflowEventCommitter,
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const store = yield* WorkflowEventStore;
    const pipeline = yield* WorkflowProjectionPipeline;
    const sql = yield* SqlClient.SqlClient;
    delayedPipelineStartRelease = release;
    delayedPipelineStartAttempts = 0;

    const appendAndProject = (event: Parameters<WorkflowEventCommitterShape["commit"]>[0]) =>
      Effect.gen(function* () {
        if (event.type === "PipelineStarted") {
          delayedPipelineStartAttempts += 1;
          yield* Deferred.await(release);
        }
        const persisted = yield* store.append(event);
        yield* pipeline.projectEvent(persisted);
        return persisted;
      });

    return {
      commit: (event) => appendAndProject(event).pipe(Effect.asVoid),
      commitMany: (events) =>
        sql
          .withTransaction(Effect.forEach(events, appendAndProject, { concurrency: 1 }))
          .pipe(Effect.mapError(toDelayedCommitterError), Effect.asVoid),
      appendManyUnlocked: (events) =>
        Effect.forEach(events, appendAndProject, { concurrency: 1 }).pipe(
          Effect.mapError(toDelayedCommitterError),
        ),
      publishTicketView: () => Effect.void,
    } satisfies WorkflowEventCommitterShape;
  }),
);

const recoveryWipLayer = it.layer(
  WorkflowRecoveryLive.pipe(
    Layer.provideMerge(ProviderDispatchOutboxLive),
    Layer.provideMerge(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TurnStateReader, {
        read: () => Effect.succeed({ _tag: "completed" as const }),
      }),
    ),
    Layer.provideMerge(DurableApprovalResumeLive),
    Layer.provideMerge(WorktreeLeaseServiceLive),
    Layer.provideMerge(WorkflowEngineLayer),
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(recoveryWipExecutor),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(recoveryBoardRegistry),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(recoveryWipFileLoader),
    Layer.provideMerge(
      Layer.succeed(ProjectWorkspaceResolver, {
        resolve: () => Effect.succeed("/tmp/recovery-project"),
      }),
    ),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(recoveryPreloadSupport),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const delayedPipelineStartRecoveryLayer = it.layer(
  WorkflowRecoveryLive.pipe(
    Layer.provideMerge(ProviderDispatchOutboxLive),
    Layer.provideMerge(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TurnStateReader, {
        read: () => Effect.succeed({ _tag: "completed" as const }),
      }),
    ),
    Layer.provideMerge(DurableApprovalResumeLive),
    Layer.provideMerge(WorktreeLeaseServiceLive),
    Layer.provideMerge(WorkflowEngineLayer),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(recoveryWipExecutor),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(recoveryBoardRegistry),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(recoveryWipFileLoader),
    Layer.provideMerge(
      Layer.succeed(ProjectWorkspaceResolver, {
        resolve: () => Effect.succeed("/tmp/recovery-project"),
      }),
    ),
    Layer.provideMerge(delayedPipelineStartCommitter),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(recoveryPreloadSupport),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const waitForRecoveryCondition = <E>(
  condition: Effect.Effect<boolean, E>,
  label: string,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (yield* condition) {
        return;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    assert.fail(`Timed out waiting for ${label}`);
  });

const workflowEventCount = (sql: SqlClient.SqlClient, ticketId: string, eventType: string) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM workflow_events
    WHERE ticket_id = ${ticketId}
      AND event_type = ${eventType}
  `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

const pipelineStartsForToken = (
  sql: SqlClient.SqlClient,
  ticketId: string,
  laneEntryToken: string,
) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM workflow_events
    WHERE ticket_id = ${ticketId}
      AND event_type = 'PipelineStarted'
      AND json_extract(payload_json, '$.laneEntryToken') = ${laneEntryToken}
  `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

const decodeAwaitingPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      providerRequestId: Schema.optional(Schema.String),
      providerQuestionId: Schema.optional(Schema.String),
    }),
  ),
);

it.effect("recovers provider user-input waits with a fresh request before accepting answers", () =>
  Effect.gen(function* () {
    const providerStarts = yield* Ref.make<ReadonlyArray<string>>([]);
    const responses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const providerTestLayer = Layer.mergeAll(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: (request) =>
          Ref.update(providerStarts, (starts) => [...starts, request.dispatchId as string]).pipe(
            Effect.as({ turnId: "turn-live" as never }),
          ),
      }),
      Layer.succeed(TurnStateReader, {
        read: (threadId) =>
          Ref.get(responses).pipe(
            Effect.map((calls) =>
              calls.length > 0
                ? ({ _tag: "completed" } as const)
                : ({
                    _tag: "awaiting_user",
                    waitingReason: "Live provider question",
                    providerThreadId: threadId,
                    providerRequestId: "request-live" as never,
                    providerResponseKind: "user-input" as const,
                    providerQuestionId: "question-live",
                  } as const),
            ),
          ),
      }),
      Layer.succeed(ProviderResponsePort, {
        respond: (input) => Ref.update(responses, (calls) => [...calls, input]),
      }),
    );
    const workflowTestLayer = Layer.mergeAll(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
      Layer.succeed(StepExecutor, { execute: () => Effect.die("unused") }),
      Layer.succeed(WorkflowFileLoader, {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) => Effect.succeed(input.boardId),
      }),
      Layer.succeed(ProjectWorkspaceResolver, {
        resolve: () => Effect.succeed("/tmp/recovery-project"),
      }),
    );
    const recoveryLayer = WorkflowRecoveryLive.pipe(
      Layer.provideMerge(ProviderDispatchOutboxLive),
      Layer.provideMerge(providerTestLayer),
      Layer.provideMerge(DurableApprovalResumeLive),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(WorkflowEngineLayer),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(workflowTestLayer),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowRoutingContextBuilderLive),
      Layer.provideMerge(DeterministicWorkflowIds),
      Layer.provideMerge(recoveryPreloadSupport),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const recovery = yield* WorkflowRecovery;
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("board-live-wait" as never, {
        name: "Live Wait",
        lanes: [
          {
            key: "impl",
            name: "Impl",
            entry: "manual",
            pipeline: [
              {
                key: "ask",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "ask",
              },
            ],
          },
        ],
      });
      yield* read.registerBoard({
        boardId: "board-live-wait" as never,
        projectId: "project-live-wait" as never,
        name: "Live Wait",
        workflowFilePath: ".t3/boards/live-wait.json",
        workflowVersionHash: "hash-live-wait",
        maxConcurrentTickets: 1,
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-live-wait-created" as never,
        ticketId: "ticket-live-wait" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "board-live-wait" as never,
          title: "Live wait",
          laneKey: "impl" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-live-wait-moved" as never,
        ticketId: "ticket-live-wait" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "token-live-wait" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-live-wait-pipeline" as never,
        ticketId: "ticket-live-wait" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-live-wait" as never,
          laneKey: "impl" as never,
          laneEntryToken: "token-live-wait" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-live-wait-step" as never,
        ticketId: "ticket-live-wait" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-live-wait" as never,
          stepRunId: "step-live-wait" as never,
          stepKey: "ask" as never,
          stepType: "agent",
        },
      } as never);
      yield* committer.commit({
        type: "StepAwaitingUser",
        eventId: "evt-live-wait-stale-await" as never,
        ticketId: "ticket-live-wait" as never,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          stepRunId: "step-live-wait" as never,
          waitingReason: "Stale provider question",
          providerThreadId: "thread-live-wait" as never,
          providerRequestId: "request-stale" as never,
          providerResponseKind: "user-input",
          providerQuestionId: "question-stale",
        },
      } as never);
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
          'thread-live-wait',
          'turn-stale',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-06-07T00:00:04.000Z',
          '2026-06-07T00:00:04.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
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
          'dispatch-live-wait',
          'ticket-live-wait',
          'step-live-wait',
          'thread-live-wait',
          'codex',
          'gpt-5.5',
          'ask',
          '/tmp/live-wait',
          'started',
          'turn-stale',
          '2026-06-07T00:00:04.000Z',
          '2026-06-07T00:00:04.000Z'
        )
      `;

      yield* recovery.recover();

      assert.deepEqual(yield* Ref.get(providerStarts), ["dispatch-live-wait"]);
      const waitRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM workflow_events
        WHERE ticket_id = 'ticket-live-wait'
          AND event_type = 'StepAwaitingUser'
        ORDER BY sequence ASC
      `;
      const latestPayload = yield* decodeAwaitingPayloadJson(waitRows.at(-1)?.payloadJson ?? "{}");
      assert.equal(latestPayload.providerRequestId, "request-live");
      assert.equal(latestPayload.providerQuestionId, "question-live");

      yield* engine.answerTicketStep({
        stepRunId: "step-live-wait" as never,
        text: "Use the live answer.",
      });

      assert.deepEqual(
        (yield* Ref.get(responses)).map((response) => ({
          requestId: response.requestId as string,
          questionId: response.questionId,
          text: response.text,
        })),
        [
          {
            requestId: "request-live",
            questionId: "question-live",
            text: "Use the live answer.",
          },
        ],
      );
    }).pipe(Effect.provide(recoveryLayer));
  }),
);

it.effect("starts recovered provider waits once when the fresh turn is still running", () =>
  Effect.gen(function* () {
    const providerStarts = yield* Ref.make<ReadonlyArray<string>>([]);
    const runningTurnLayer = WorkflowRecoveryLive.pipe(
      Layer.provideMerge(ProviderDispatchOutboxLive),
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: (request) =>
            Ref.modify(providerStarts, (starts) => [
              { turnId: `turn-live-${starts.length + 1}` as never },
              [...starts, request.dispatchId as string],
            ]),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "running" as const }),
        }),
      ),
      Layer.provideMerge(DurableApprovalResumeLive),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(WorkflowFileLoader, {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) => Effect.succeed(input.boardId),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectWorkspaceResolver, {
          resolve: () => Effect.succeed("/tmp/recovery-project"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowEngine, {
          createTicket: () => Effect.die("unused createTicket"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.die("unused moveTicket"),
          createTicketAndEnterUnlocked: () => Effect.die("unused createTicketAndEnterUnlocked"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          cancellableProviderTurnsForTicket: () =>
            Effect.die("unused closeTicketFromSourceUnlocked"),
          supersedeProviderWorkForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          terminalAgentSessionThreadsForTicket: () =>
            Effect.die("unused closeTicketFromSourceUnlocked"),
          stopAgentSessionsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          editTicketFieldsUnlocked: () => Effect.die("unused editTicketFieldsUnlocked"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.die("unused runLane"),
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.die("unused resolveApproval"),
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.die("unused cancelStep"),
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowIds, {
          ticketId: () => Effect.succeed("ticket-unused" as never),
          pipelineRunId: () => Effect.succeed("pipeline-unused" as never),
          scriptRunId: () => Effect.succeed("script-unused" as never),
          stepRunId: () => Effect.succeed("step-unused" as never),
          messageId: () => Effect.succeed("message-unused" as never),
          eventId: () =>
            Effect.sync(() => {
              recoveryEventId += 1;
              return `evt-running-recovery-${recoveryEventId}` as never;
            }),
          token: () => Effect.succeed("token-unused" as never),
          mappingId: () => Effect.succeed("mapping-unused" as never),
        }),
      ),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(recoveryPreloadSupport),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const recovery = yield* WorkflowRecovery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-running-wait',
          'project-running-wait',
          'Running Wait',
          '.t3/boards/running-wait.json',
          'hash-running-wait',
          1
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'ticket-running-wait',
          'board-running-wait',
          'Running wait',
          'impl',
          'waiting_on_user',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:04.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_events (
          event_id,
          ticket_id,
          stream_version,
          event_type,
          occurred_at,
          payload_json
        )
        VALUES (
          'evt-running-wait-stale',
          'ticket-running-wait',
          0,
          'StepAwaitingUser',
          '2026-06-07T00:00:04.000Z',
          '{"stepRunId":"step-running-wait","waitingReason":"Stale provider question","providerThreadId":"thread-running-wait","providerRequestId":"request-stale","providerResponseKind":"user-input","providerQuestionId":"question-stale"}'
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
          'thread-running-wait',
          'turn-stale',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-06-07T00:00:03.000Z',
          '2026-06-07T00:00:03.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
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
          'dispatch-running-wait',
          'ticket-running-wait',
          'step-running-wait',
          'thread-running-wait',
          'codex',
          'gpt-5.5',
          'ask',
          '/tmp/running-wait',
          'started',
          'turn-stale',
          '2026-06-07T00:00:03.000Z',
          '2026-06-07T00:00:03.000Z'
        )
      `;

      yield* recovery.recover();

      assert.deepEqual(yield* Ref.get(providerStarts), ["dispatch-running-wait"]);
      const dispatchRows = yield* sql<{
        readonly status: string;
        readonly turnId: string | null;
      }>`
        SELECT
          status,
          turn_id AS "turnId"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-running-wait'
      `;
      assert.deepEqual(dispatchRows[0], { status: "started", turnId: "turn-live-1" });
    }).pipe(Effect.provide(runningTurnLayer));
  }),
);

it.effect("recommits recovered provider approval requests after stale dispatch cleanup", () =>
  Effect.gen(function* () {
    const providerStarts = yield* Ref.make<ReadonlyArray<string>>([]);
    const requestRecoveryLayer = WorkflowRecoveryLive.pipe(
      Layer.provideMerge(ProviderDispatchOutboxLive),
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: (request) =>
            Ref.update(providerStarts, (starts) => [...starts, request.dispatchId as string]).pipe(
              Effect.as({ turnId: "turn-request-live" as never }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: (threadId) =>
            Ref.get(providerStarts).pipe(
              Effect.map((starts) =>
                starts.length === 0
                  ? ({ _tag: "running" } as const)
                  : ({
                      _tag: "awaiting_user" as const,
                      waitingReason: "Approve the recovered command?",
                      providerThreadId: threadId,
                      providerRequestId: "request-approval-live" as never,
                      providerResponseKind: "request" as const,
                    } as const),
              ),
            ),
        }),
      ),
      Layer.provideMerge(DurableApprovalResumeLive),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(WorkflowFileLoader, {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) => Effect.succeed(input.boardId),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectWorkspaceResolver, {
          resolve: () => Effect.succeed("/tmp/recovery-project"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowEngine, {
          createTicket: () => Effect.die("unused createTicket"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.die("unused moveTicket"),
          createTicketAndEnterUnlocked: () => Effect.die("unused createTicketAndEnterUnlocked"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          cancellableProviderTurnsForTicket: () =>
            Effect.die("unused closeTicketFromSourceUnlocked"),
          supersedeProviderWorkForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          terminalAgentSessionThreadsForTicket: () =>
            Effect.die("unused closeTicketFromSourceUnlocked"),
          stopAgentSessionsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          editTicketFieldsUnlocked: () => Effect.die("unused editTicketFieldsUnlocked"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.die("unused runLane"),
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.die("unused resolveApproval"),
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.die("unused cancelStep"),
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowIds, {
          ticketId: () => Effect.succeed("ticket-unused" as never),
          pipelineRunId: () => Effect.succeed("pipeline-unused" as never),
          scriptRunId: () => Effect.succeed("script-unused" as never),
          stepRunId: () => Effect.succeed("step-unused" as never),
          messageId: () => Effect.succeed("message-unused" as never),
          eventId: () =>
            Effect.sync(() => {
              recoveryEventId += 1;
              return `evt-request-recovery-${recoveryEventId}` as never;
            }),
          token: () => Effect.succeed("token-unused" as never),
          mappingId: () => Effect.succeed("mapping-unused" as never),
        }),
      ),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(recoveryPreloadSupport),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const recovery = yield* WorkflowRecovery;
      const registry = yield* BoardRegistry;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("board-request-wait" as never, {
        name: "Request Wait",
        lanes: [{ key: "impl", name: "Impl", entry: "manual" }],
      });
      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-request-wait',
          'project-request-wait',
          'Request Wait',
          '.t3/boards/request-wait.json',
          'hash-request-wait',
          1
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'ticket-request-wait',
          'board-request-wait',
          'Request wait',
          'impl',
          'waiting_on_user',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:04.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_events (
          event_id,
          ticket_id,
          stream_version,
          event_type,
          occurred_at,
          payload_json
        )
        VALUES (
          'evt-request-wait-stale',
          'ticket-request-wait',
          0,
          'StepAwaitingUser',
          '2026-06-07T00:00:04.000Z',
          '{"stepRunId":"step-request-wait","waitingReason":"Stale approval","providerThreadId":"thread-request-wait","providerRequestId":"request-approval-stale","providerResponseKind":"request"}'
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
          'thread-request-wait',
          'turn-request-stale',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-06-07T00:00:03.000Z',
          '2026-06-07T00:00:03.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
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
          'dispatch-request-wait',
          'ticket-request-wait',
          'step-request-wait',
          'thread-request-wait',
          'codex',
          'gpt-5.5',
          'approve',
          '/tmp/request-wait',
          'started',
          'turn-request-stale',
          '2026-06-07T00:00:03.000Z',
          '2026-06-07T00:00:03.000Z'
        )
      `;

      yield* recovery.recover();
      assert.deepEqual(yield* Ref.get(providerStarts), ["dispatch-request-wait"]);
      const dispatchRows = yield* sql<{
        readonly status: string;
        readonly turnId: string | null;
      }>`
        SELECT
          status,
          turn_id AS "turnId"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-request-wait'
      `;
      assert.deepEqual(dispatchRows[0], {
        status: "started",
        turnId: "turn-request-live",
      });
      yield* waitForRecoveryCondition(
        workflowEventCount(sql, "ticket-request-wait", "StepAwaitingUser").pipe(
          Effect.map((count) => count === 2),
        ),
        "recovered provider approval wait",
      );

      const waitRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM workflow_events
        WHERE ticket_id = 'ticket-request-wait'
          AND event_type = 'StepAwaitingUser'
        ORDER BY sequence ASC
      `;
      const latestPayload = yield* decodeAwaitingPayloadJson(waitRows.at(-1)?.payloadJson ?? "{}");
      assert.equal(latestPayload.providerRequestId, "request-approval-live");
    }).pipe(Effect.provide(requestRecoveryLayer));
  }),
);

it.effect("fails an interrupted panel step even when only one member row is still started", () =>
  Effect.gen(function* () {
    const recovered = yield* Ref.make<
      ReadonlyArray<{ readonly stepRunId: string; readonly result: unknown }>
    >([]);
    const providerStarts = yield* Ref.make<ReadonlyArray<string>>([]);
    const panelRecoveryLayer = WorkflowRecoveryLive.pipe(
      Layer.provideMerge(ProviderDispatchOutboxLive),
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          // A dead panel member must never be re-dispatched by recovery.
          ensureTurnStarted: (request) =>
            Ref.update(providerStarts, (starts) => [...starts, request.dispatchId as string]).pipe(
              Effect.as({ turnId: "turn-panel-live" as never }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          // Member 2 of panel A crashed mid-turn (projected 'running');
          // member 2 of panel B reached a terminal turn before the crash.
          // Neither may decide its panel single-handedly.
          read: (threadId) =>
            Effect.succeed(
              (threadId as string) === "thread-panel-b-member-2"
                ? ({ _tag: "completed" } as const)
                : ({ _tag: "running" } as const),
            ),
        }),
      ),
      Layer.provideMerge(DurableApprovalResumeLive),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(WorkflowFileLoader, {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) => Effect.succeed(input.boardId),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectWorkspaceResolver, {
          resolve: () => Effect.succeed("/tmp/recovery-project"),
        }),
      ),
      Layer.provideMerge(
        Layer.effect(
          WorkflowEngine,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              createTicket: () => Effect.die("unused createTicket"),
              editTicket: () => Effect.void,
              moveTicket: () => Effect.die("unused moveTicket"),
              createTicketAndEnterUnlocked: () => Effect.die("unused createTicketAndEnterUnlocked"),
              closeTicketFromSourceUnlocked: () =>
                Effect.die("unused closeTicketFromSourceUnlocked"),
              reopenTicketFromSourceUnlocked: () =>
                Effect.die("unused closeTicketFromSourceUnlocked"),
              cancellableProviderTurnsForTicket: () =>
                Effect.die("unused closeTicketFromSourceUnlocked"),
              supersedeProviderWorkForTicket: () =>
                Effect.die("unused closeTicketFromSourceUnlocked"),
              terminalAgentSessionThreadsForTicket: () =>
                Effect.die("unused closeTicketFromSourceUnlocked"),
              stopAgentSessionsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
              editTicketFieldsUnlocked: () => Effect.die("unused editTicketFieldsUnlocked"),
              withBoardAdmissionLock: (_boardId, effect) => effect,
              runLane: () => Effect.die("unused runLane"),
              ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
              resolveApproval: () => Effect.die("unused resolveApproval"),
              answerTicketStep: () => Effect.void,
              postTicketMessage: () => Effect.void,
              editTicketMessage: () => Effect.void,
              cancelStep: () => Effect.die("unused cancelStep"),
              cancelBoardPipelines: () => Effect.void,
              cancelTicketPipelines: () => Effect.void,
              recoverBoardWip: () => Effect.void,
              // Record the call and settle the projection like the real
              // engine would, so later recovery stages see the step done.
              completeRecoveredStep: (stepRunId, result) =>
                Ref.update(recovered, (calls) => [
                  ...calls,
                  { stepRunId: stepRunId as string, result },
                ]).pipe(
                  Effect.andThen(
                    sql`
                      UPDATE projection_step_run
                      SET status = 'failed'
                      WHERE step_run_id = ${stepRunId as string}
                    `.pipe(Effect.orDie),
                  ),
                  Effect.asVoid,
                ),
            };
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowIds, {
          ticketId: () => Effect.succeed("ticket-unused" as never),
          pipelineRunId: () => Effect.succeed("pipeline-unused" as never),
          scriptRunId: () => Effect.succeed("script-unused" as never),
          stepRunId: () => Effect.succeed("step-unused" as never),
          messageId: () => Effect.succeed("message-unused" as never),
          eventId: () =>
            Effect.sync(() => {
              recoveryEventId += 1;
              return `evt-panel-recovery-${recoveryEventId}` as never;
            }),
          token: () => Effect.succeed("token-unused" as never),
          mappingId: () => Effect.succeed("mapping-unused" as never),
        }),
      ),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(recoveryPreloadSupport),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const recovery = yield* WorkflowRecovery;
      const registry = yield* BoardRegistry;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("board-panel-recovery" as never, {
        name: "Panel Recovery",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "manual",
            pipeline: [
              {
                key: "panel-review",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "review the work",
                captureOutput: true,
                panel: 3,
              },
            ],
          },
        ],
      });
      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-panel-recovery',
          'project-panel-recovery',
          'Panel Recovery',
          '.t3/boards/panel-recovery.json',
          'hash-panel-recovery',
          1
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES
          (
            'ticket-panel-recovery',
            'board-panel-recovery',
            'Panel recovery',
            'review',
            'running',
            '2026-06-07T00:00:00.000Z',
            '2026-06-07T00:00:02.000Z'
          ),
          (
            'ticket-panel-recovery-b',
            'board-panel-recovery',
            'Panel recovery B',
            'review',
            'running',
            '2026-06-07T00:00:00.000Z',
            '2026-06-07T00:00:02.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_step_run (
          step_run_id,
          pipeline_run_id,
          ticket_id,
          step_key,
          step_type,
          status,
          started_at
        )
        VALUES
          (
            'step-panel-recovery',
            'pipeline-panel-recovery',
            'ticket-panel-recovery',
            'panel-review',
            'agent',
            'running',
            '2026-06-07T00:00:00.000Z'
          ),
          (
            'step-panel-recovery-b',
            'pipeline-panel-recovery-b',
            'ticket-panel-recovery-b',
            'panel-review',
            'agent',
            'running',
            '2026-06-07T00:00:00.000Z'
          )
      `;
      // A 3-member sequential panel crashed mid-member-2: member 1 already
      // confirmed, member 3 was never dispatched. Only member 2 is 'started'.
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
          started_at,
          confirmed_at
        )
        VALUES
          (
            'dispatch-panel-member-1',
            'ticket-panel-recovery',
            'step-panel-recovery',
            'thread-panel-member-1',
            'codex',
            'gpt-5.5',
            'review the work',
            '/tmp/panel-recovery',
            'confirmed',
            'turn-panel-member-1',
            '2026-06-07T00:00:00.000Z',
            '2026-06-07T00:00:00.000Z',
            '2026-06-07T00:00:01.000Z'
          ),
          (
            'dispatch-panel-member-2',
            'ticket-panel-recovery',
            'step-panel-recovery',
            'thread-panel-member-2',
            'codex',
            'gpt-5.5',
            'review the work',
            '/tmp/panel-recovery',
            'started',
            'turn-panel-member-2',
            '2026-06-07T00:00:01.000Z',
            '2026-06-07T00:00:01.000Z',
            NULL
          ),
          (
            'dispatch-panel-b-member-1',
            'ticket-panel-recovery-b',
            'step-panel-recovery-b',
            'thread-panel-b-member-1',
            'codex',
            'gpt-5.5',
            'review the work',
            '/tmp/panel-recovery-b',
            'confirmed',
            'turn-panel-b-member-1',
            '2026-06-07T00:00:00.000Z',
            '2026-06-07T00:00:00.000Z',
            '2026-06-07T00:00:01.000Z'
          ),
          (
            'dispatch-panel-b-member-2',
            'ticket-panel-recovery-b',
            'step-panel-recovery-b',
            'thread-panel-b-member-2',
            'codex',
            'gpt-5.5',
            'review the work',
            '/tmp/panel-recovery-b',
            'started',
            'turn-panel-b-member-2',
            '2026-06-07T00:00:01.000Z',
            '2026-06-07T00:00:01.000Z',
            NULL
          )
      `;

      yield* recovery.recover();

      // No panel member may be re-dispatched: recovery must settle the
      // panels without starting fresh provider turns for dead members.
      assert.deepEqual(yield* Ref.get(providerStarts), []);
      const recoveredCalls = [...(yield* Ref.get(recovered))].sort((a, b) =>
        a.stepRunId.localeCompare(b.stepRunId),
      );
      assert.deepEqual(recoveredCalls, [
        {
          stepRunId: "step-panel-recovery",
          result: {
            _tag: "failed",
            error: "review panel interrupted by restart",
            retryable: true,
          },
        },
        {
          stepRunId: "step-panel-recovery-b",
          result: {
            _tag: "failed",
            error: "review panel interrupted by restart",
            retryable: true,
          },
        },
      ]);
      const outboxRows = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM workflow_dispatch_outbox
        WHERE step_run_id IN ('step-panel-recovery', 'step-panel-recovery-b')
        ORDER BY dispatch_id ASC
      `;
      assert.deepEqual(
        outboxRows.map((row) => row.status),
        ["confirmed", "confirmed", "confirmed", "confirmed"],
      );
    }).pipe(Effect.provide(panelRecoveryLayer));
  }),
);

recoveryWipLayer("WorkflowRecovery WIP admission", (it) => {
  it.effect(
    "preloads persisted boards, admits queued tickets, and restarts stranded auto tickets",
    () =>
      Effect.gen(function* () {
        loadedRecoveryBoards.length = 0;
        recoveryStepExecutions = 0;
        const recovery = yield* WorkflowRecovery;
        const registry = yield* BoardRegistry;
        const read = yield* WorkflowReadModel;
        const committer = yield* WorkflowEventCommitter;
        const sql = yield* SqlClient.SqlClient;

        yield* registry.register("b-recovery-wip" as never, recoveryWipDefinition);
        yield* read.registerBoard({
          boardId: "b-recovery-wip" as never,
          projectId: "p-recovery-wip" as never,
          name: "Recovery WIP",
          workflowFilePath: ".t3/boards/recovery-wip.json",
          workflowVersionHash: "hash-recovery-wip",
          maxConcurrentTickets: 3,
        });
        yield* committer.commit({
          type: "TicketCreated",
          eventId: "evt-recovery-queued-created" as never,
          ticketId: "ticket-recovery-queued" as never,
          occurredAt: "2026-06-07T00:00:00.000Z" as never,
          payload: {
            boardId: "b-recovery-wip" as never,
            title: "Queued recovery",
            laneKey: "queue" as never,
          },
        } as never);
        yield* committer.commit({
          type: "TicketQueued",
          eventId: "evt-recovery-queued" as never,
          ticketId: "ticket-recovery-queued" as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: { lane: "queue" as never },
        } as never);
        yield* committer.commit({
          type: "TicketCreated",
          eventId: "evt-recovery-stranded-created" as never,
          ticketId: "ticket-recovery-stranded" as never,
          occurredAt: "2026-06-07T00:00:02.000Z" as never,
          payload: {
            boardId: "b-recovery-wip" as never,
            title: "Stranded recovery",
            laneKey: "stranded" as never,
          },
        } as never);
        yield* committer.commit({
          type: "TicketMovedToLane",
          eventId: "evt-recovery-stranded-admitted" as never,
          ticketId: "ticket-recovery-stranded" as never,
          occurredAt: "2026-06-07T00:00:03.000Z" as never,
          payload: {
            toLane: "stranded" as never,
            laneEntryToken: "tok-recovery-stranded" as never,
            reason: "initial",
          },
        } as never);

        yield* recovery.recover();

        assert.deepEqual(loadedRecoveryBoards, ["b-recovery-wip"]);
        yield* waitForRecoveryCondition(
          Effect.gen(function* () {
            const queued = yield* read.getTicketDetail("ticket-recovery-queued" as never);
            return (
              queued !== null &&
              queued.ticket.currentLaneEntryToken !== null &&
              queued.ticket.queuedAt === null
            );
          }),
          "queued ticket admission",
        );
        yield* waitForRecoveryCondition(
          Effect.gen(function* () {
            const queuedStarts = yield* workflowEventCount(
              sql,
              "ticket-recovery-queued",
              "PipelineStarted",
            );
            const strandedStarts = yield* workflowEventCount(
              sql,
              "ticket-recovery-stranded",
              "PipelineStarted",
            );
            return queuedStarts === 1 && strandedStarts === 1;
          }),
          "recovered auto pipeline starts",
        );
        assert.equal(yield* workflowEventCount(sql, "ticket-recovery-queued", "TicketAdmitted"), 1);

        yield* recovery.recover();
        yield* waitForRecoveryCondition(
          Effect.gen(function* () {
            const queuedAdmits = yield* workflowEventCount(
              sql,
              "ticket-recovery-queued",
              "TicketAdmitted",
            );
            const queuedStarts = yield* workflowEventCount(
              sql,
              "ticket-recovery-queued",
              "PipelineStarted",
            );
            const strandedStarts = yield* workflowEventCount(
              sql,
              "ticket-recovery-stranded",
              "PipelineStarted",
            );
            return queuedAdmits === 1 && queuedStarts === 1 && strandedStarts === 1;
          }),
          "idempotent WIP recovery",
        );
        assert.equal(recoveryStepExecutions, 2);
      }),
  );
});

delayedPipelineStartRecoveryLayer("WorkflowEngine delayed start idempotency", (it) => {
  it.effect("skips duplicate runLane starts for the same token while allowing a new token", () =>
    Effect.gen(function* () {
      delayedPipelineStartAttempts = 0;
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("b-runlane-idempotent" as never, recoveryWipDefinition);
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-runlane-idempotent-created" as never,
        ticketId: "ticket-runlane-idempotent" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-runlane-idempotent" as never,
          title: "Run lane idempotent",
          laneKey: "queue" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-runlane-idempotent-admitted" as never,
        ticketId: "ticket-runlane-idempotent" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "queue" as never,
          laneEntryToken: "tok-runlane-idempotent" as never,
          reason: "initial",
        },
      } as never);

      yield* engine.runLane("ticket-runlane-idempotent" as never);
      yield* waitForRecoveryCondition(
        Effect.sync(() => delayedPipelineStartAttempts === 1),
        "first delayed runLane start",
      );

      yield* engine.runLane("ticket-runlane-idempotent" as never);
      yield* Effect.yieldNow;
      assert.equal(delayedPipelineStartAttempts, 1);
      assert.equal(
        yield* pipelineStartsForToken(sql, "ticket-runlane-idempotent", "tok-runlane-idempotent"),
        0,
      );

      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-runlane-idempotent-new-token" as never,
        ticketId: "ticket-runlane-idempotent" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          toLane: "queue" as never,
          laneEntryToken: "tok-runlane-idempotent-new" as never,
          reason: "manual",
        },
      } as never);
      yield* engine.runLane("ticket-runlane-idempotent" as never);
      yield* waitForRecoveryCondition(
        Effect.sync(() => delayedPipelineStartAttempts === 2),
        "new-token delayed runLane start",
      );

      const release = delayedPipelineStartRelease;
      assert.isNotNull(release);
      if (release === null) {
        assert.fail("expected delayed pipeline start release gate");
      }
      yield* Deferred.succeed(release, undefined);
      yield* waitForRecoveryCondition(
        Effect.gen(function* () {
          const originalStarts = yield* pipelineStartsForToken(
            sql,
            "ticket-runlane-idempotent",
            "tok-runlane-idempotent",
          );
          const newStarts = yield* pipelineStartsForToken(
            sql,
            "ticket-runlane-idempotent",
            "tok-runlane-idempotent-new",
          );
          return originalStarts === 1 && newStarts === 1;
        }),
        "original and new-token pipeline starts",
      );
      assert.equal(
        yield* pipelineStartsForToken(sql, "ticket-runlane-idempotent", "tok-runlane-idempotent"),
        1,
      );
      assert.equal(
        yield* pipelineStartsForToken(
          sql,
          "ticket-runlane-idempotent",
          "tok-runlane-idempotent-new",
        ),
        1,
      );
    }),
  );
});

delayedPipelineStartRecoveryLayer("WorkflowRecovery delayed WIP start", (it) => {
  it.effect("starts recovered auto tickets once across two in-flight recoveries", () =>
    Effect.gen(function* () {
      loadedRecoveryBoards.length = 0;
      recoveryStepExecutions = 0;
      const recovery = yield* WorkflowRecovery;
      const read = yield* WorkflowReadModel;
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;

      yield* read.registerBoard({
        boardId: "b-recovery-delayed-start" as never,
        projectId: "p-recovery-delayed-start" as never,
        name: "Recovery delayed start",
        workflowFilePath: ".t3/boards/recovery-delayed-start.json",
        workflowVersionHash: "hash-recovery-delayed-start",
        maxConcurrentTickets: 3,
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-recovery-delayed-created" as never,
        ticketId: "ticket-recovery-delayed" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-recovery-delayed-start" as never,
          title: "Queued delayed recovery",
          laneKey: "queue" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketQueued",
        eventId: "evt-recovery-delayed-queued" as never,
        ticketId: "ticket-recovery-delayed" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { lane: "queue" as never },
      } as never);
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-recovery-delayed-stranded-created" as never,
        ticketId: "ticket-recovery-delayed-stranded" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          boardId: "b-recovery-delayed-start" as never,
          title: "Stranded delayed recovery",
          laneKey: "stranded" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-recovery-delayed-stranded-admitted" as never,
        ticketId: "ticket-recovery-delayed-stranded" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          toLane: "stranded" as never,
          laneEntryToken: "tok-recovery-delayed-stranded" as never,
          reason: "initial",
        },
      } as never);

      const recoveryFiber = yield* recovery.recover().pipe(Effect.forkScoped);
      yield* waitForRecoveryCondition(
        Effect.sync(() => delayedPipelineStartAttempts === 2),
        "delayed pipeline start attempts",
      );
      yield* Fiber.join(recoveryFiber);

      const admitted = yield* read.getTicketDetail("ticket-recovery-delayed" as never);
      const laneEntryToken = admitted?.ticket.currentLaneEntryToken;
      assert.isNotNull(laneEntryToken ?? null);
      if (laneEntryToken === null || laneEntryToken === undefined) {
        assert.fail("expected recovery admission to assign a token");
      }

      yield* recovery.recover();
      yield* Effect.yieldNow;
      assert.equal(delayedPipelineStartAttempts, 2);
      assert.equal(
        yield* pipelineStartsForToken(sql, "ticket-recovery-delayed", laneEntryToken),
        0,
      );
      assert.equal(
        yield* pipelineStartsForToken(
          sql,
          "ticket-recovery-delayed-stranded",
          "tok-recovery-delayed-stranded",
        ),
        0,
      );

      const release = delayedPipelineStartRelease;
      assert.isNotNull(release);
      if (release === null) {
        assert.fail("expected delayed pipeline start release gate");
      }
      yield* Deferred.succeed(release, undefined);
      yield* waitForRecoveryCondition(
        Effect.gen(function* () {
          const queuedStarts = yield* pipelineStartsForToken(
            sql,
            "ticket-recovery-delayed",
            laneEntryToken,
          );
          const strandedStarts = yield* pipelineStartsForToken(
            sql,
            "ticket-recovery-delayed-stranded",
            "tok-recovery-delayed-stranded",
          );
          return queuedStarts === 1 && strandedStarts === 1;
        }),
        "single delayed pipeline starts",
      );
      assert.equal(
        yield* pipelineStartsForToken(sql, "ticket-recovery-delayed", laneEntryToken),
        1,
      );
      assert.equal(
        yield* pipelineStartsForToken(
          sql,
          "ticket-recovery-delayed-stranded",
          "tok-recovery-delayed-stranded",
        ),
        1,
      );

      yield* recovery.recover();
      assert.equal(
        yield* pipelineStartsForToken(sql, "ticket-recovery-delayed", laneEntryToken),
        1,
      );
      assert.equal(
        yield* pipelineStartsForToken(
          sql,
          "ticket-recovery-delayed-stranded",
          "tok-recovery-delayed-stranded",
        ),
        1,
      );
    }),
  );
});

it.effect("cascades persisted boards whose workflow file is missing during preload", () =>
  Effect.gen(function* () {
    const cancelledBoards = yield* Ref.make<ReadonlyArray<string>>([]);
    const unregisteredBoards = yield* Ref.make<ReadonlyArray<string>>([]);
    const missingFileLayer = WorkflowRecoveryLive.pipe(
      Layer.provideMerge(ProviderDispatchOutboxLive),
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "completed" as const }),
        }),
      ),
      Layer.provideMerge(DurableApprovalResumeLive),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(WorkflowFileLoader, {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () =>
            Effect.fail(
              new WorkflowRpcError({
                message: "workflow file read failed",
                cause: { reason: { _tag: "NotFound" } } as never,
              }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectWorkspaceResolver, {
          resolve: () => Effect.succeed("/tmp/recovery-project"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(BoardRegistry, {
          register: () => Effect.die("unused"),
          unregister: (boardId) =>
            Ref.update(unregisteredBoards, (boards) => [...boards, boardId as string]),
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowEngine, {
          createTicket: () => Effect.die("unused createTicket"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.die("unused moveTicket"),
          createTicketAndEnterUnlocked: () => Effect.die("unused createTicketAndEnterUnlocked"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          cancellableProviderTurnsForTicket: () =>
            Effect.die("unused closeTicketFromSourceUnlocked"),
          supersedeProviderWorkForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          terminalAgentSessionThreadsForTicket: () =>
            Effect.die("unused closeTicketFromSourceUnlocked"),
          stopAgentSessionsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
          editTicketFieldsUnlocked: () => Effect.die("unused editTicketFieldsUnlocked"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.die("unused runLane"),
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.die("unused resolveApproval"),
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.die("unused cancelStep"),
          cancelBoardPipelines: (boardId) =>
            Ref.update(cancelledBoards, (boards) => [...boards, boardId as string]),
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.die("stale board must not recover wip"),
          completeRecoveredStep: () => Effect.die("unused completeRecoveredStep"),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkflowIds, {
          ticketId: () => Effect.succeed("ticket-unused" as never),
          pipelineRunId: () => Effect.succeed("pipeline-unused" as never),
          scriptRunId: () => Effect.succeed("script-unused" as never),
          stepRunId: () => Effect.succeed("step-unused" as never),
          messageId: () => Effect.succeed("message-unused" as never),
          eventId: () => Effect.succeed("event-unused" as never),
          token: () => Effect.succeed("token-unused" as never),
          mappingId: () => Effect.succeed("mapping-unused" as never),
        }),
      ),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(recoveryPreloadSupport),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* WorkflowRecovery;
      const now = "2026-06-07T00:00:00.000Z";

      yield* sql`
          INSERT INTO projection_board (
            board_id,
            project_id,
            name,
            workflow_file_path,
            workflow_version_hash,
            max_concurrent_tickets
          )
          VALUES (
            'board-stale-file',
            'project-stale-file',
            'Stale File',
            '.t3/boards/stale-file.json',
            'hash-stale-file',
            3
          )
        `;
      yield* sql`
          INSERT INTO projection_ticket (
            ticket_id,
            board_id,
            title,
            current_lane_key,
            status,
            created_at,
            updated_at
          )
          VALUES (
            'ticket-stale-file',
            'board-stale-file',
            'Stale ticket',
            'impl',
            'running',
            ${now},
            ${now}
          )
        `;
      yield* sql`
          INSERT INTO workflow_events (
            event_id,
            ticket_id,
            stream_version,
            event_type,
            occurred_at,
            payload_json
          )
          VALUES (
            'event-stale-file',
            'ticket-stale-file',
            0,
            'TicketCreated',
            ${now},
            '{"boardId":"board-stale-file","title":"Stale ticket","laneKey":"impl"}'
          )
        `;
      yield* sql`
          INSERT INTO workflow_board_version (
            board_id,
            version_hash,
            content_json,
            source,
            created_at
          )
          VALUES (
            'board-stale-file',
            'hash-stale-file-version',
            '{"name":"Stale File"}',
            'save',
            ${now}
          )
        `;
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
            created_at
          )
          VALUES (
            'dispatch-stale-file',
            'ticket-stale-file',
            'step-stale-file',
            'thread-stale-file',
            'codex',
            'gpt-5.5',
            'stale dispatch',
            '/tmp/stale-file',
            'pending',
            ${now}
          )
        `;
      yield* sql`
          INSERT INTO workflow_setup_run (
            setup_run_id,
            ticket_id,
            worktree_ref,
            status,
            started_at
          )
          VALUES (
            'setup-stale-file',
            'ticket-stale-file',
            'worktree-stale-file',
            'running',
            ${now}
          )
        `;

      yield* recovery.recover();

      assert.deepEqual(yield* Ref.get(cancelledBoards), ["board-stale-file"]);
      assert.deepEqual(yield* Ref.get(unregisteredBoards), ["board-stale-file"]);
      const counts = yield* sql<{ readonly tableName: string; readonly count: number }>`
          SELECT 'projection_board' AS tableName, COUNT(*) AS count
          FROM projection_board
          WHERE board_id = 'board-stale-file'
          UNION ALL
          SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
          FROM projection_ticket
          WHERE board_id = 'board-stale-file'
          UNION ALL
          SELECT 'workflow_events' AS tableName, COUNT(*) AS count
          FROM workflow_events
          WHERE ticket_id = 'ticket-stale-file'
          UNION ALL
          SELECT 'workflow_board_version' AS tableName, COUNT(*) AS count
          FROM workflow_board_version
          WHERE board_id = 'board-stale-file'
          UNION ALL
          SELECT 'workflow_dispatch_outbox' AS tableName, COUNT(*) AS count
          FROM workflow_dispatch_outbox
          WHERE ticket_id = 'ticket-stale-file'
          UNION ALL
          SELECT 'workflow_setup_run' AS tableName, COUNT(*) AS count
          FROM workflow_setup_run
          WHERE ticket_id = 'ticket-stale-file'
        `;
      assert.deepEqual(
        counts.map((row) => [row.tableName, row.count]),
        [
          ["projection_board", 0],
          ["projection_ticket", 0],
          ["workflow_events", 0],
          ["workflow_board_version", 0],
          ["workflow_dispatch_outbox", 0],
          ["workflow_setup_run", 0],
        ],
      );
    }).pipe(Effect.provide(missingFileLayer));
  }),
);

it.effect("preload does not resurrect a board deleted while its save lock is held", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-workflow-recovery-preload-delete-",
      });
      const boardsDir = path.join(workspaceRoot, ".t3/boards");
      const boardPath = path.join(boardsDir, "preload-delete.json");
      const boardId = "board-preload-delete" as never;
      const projectId = "project-preload-delete" as never;
      const finishLoad = yield* Deferred.make<void>();
      const deleteLockHeld = yield* Deferred.make<void>();
      const finishDelete = yield* Deferred.make<void>();
      const loadedBoards = yield* Ref.make<ReadonlyArray<string>>([]);
      const recoveredBoards = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* fs.makeDirectory(boardsDir, { recursive: true });
      yield* fs.writeFileString(
        boardPath,
        '{"name":"Preload Delete","lanes":[{"key":"impl","name":"Impl","entry":"manual"}]}',
      );

      const preloadDeleteLayer = WorkflowRecoveryLive.pipe(
        Layer.provideMerge(ProviderDispatchOutboxLive),
        Layer.provideMerge(
          Layer.succeed(ProviderTurnPort, {
            ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(TurnStateReader, {
            read: () => Effect.succeed({ _tag: "completed" as const }),
          }),
        ),
        Layer.provideMerge(DurableApprovalResumeLive),
        Layer.provideMerge(WorktreeLeaseServiceLive),
        Layer.provideMerge(WorkflowEventCommitterLive),
        Layer.provideMerge(PredicateEvaluatorLive),
        Layer.provideMerge(WorkflowBoardSaveLocksLive),
        Layer.provideMerge(
          Layer.effect(
            WorkflowFileLoader,
            Effect.gen(function* () {
              const registry = yield* BoardRegistry;
              const read = yield* WorkflowReadModel;
              return {
                lintDefinition: () => Effect.succeed([]),
                loadAndRegister: (input) =>
                  Effect.gen(function* () {
                    yield* Ref.update(loadedBoards, (boards) => [
                      ...boards,
                      input.boardId as string,
                    ]);
                    yield* Deferred.await(finishLoad);
                    yield* registry
                      .register(input.boardId, {
                        name: "Preload Delete",
                        lanes: [{ key: "impl", name: "Impl", entry: "manual" }],
                      })
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new WorkflowRpcError({
                              message: "test board registration failed",
                              cause,
                            }),
                        ),
                      );
                    yield* read
                      .registerBoard({
                        boardId: input.boardId,
                        projectId: input.projectId,
                        name: "Preload Delete",
                        workflowFilePath: input.relativePath,
                        workflowVersionHash: "hash-preload-delete-resurrected",
                        maxConcurrentTickets: 1,
                      })
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new WorkflowRpcError({
                              message: "test board projection registration failed",
                              cause,
                            }),
                        ),
                      );
                    return input.boardId;
                  }),
              };
            }),
          ),
        ),
        Layer.provideMerge(
          Layer.succeed(ProjectWorkspaceResolver, {
            resolve: () => Effect.succeed(workspaceRoot),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkflowEngine, {
            createTicket: () => Effect.die("unused createTicket"),
            editTicket: () => Effect.void,
            moveTicket: () => Effect.die("unused moveTicket"),
            createTicketAndEnterUnlocked: () => Effect.die("unused createTicketAndEnterUnlocked"),
            closeTicketFromSourceUnlocked: () => Effect.die("unused closeTicketFromSourceUnlocked"),
            reopenTicketFromSourceUnlocked: () =>
              Effect.die("unused closeTicketFromSourceUnlocked"),
            cancellableProviderTurnsForTicket: () =>
              Effect.die("unused closeTicketFromSourceUnlocked"),
            supersedeProviderWorkForTicket: () =>
              Effect.die("unused closeTicketFromSourceUnlocked"),
            terminalAgentSessionThreadsForTicket: () =>
              Effect.die("unused closeTicketFromSourceUnlocked"),
            stopAgentSessionsForTicket: () => Effect.die("unused closeTicketFromSourceUnlocked"),
            editTicketFieldsUnlocked: () => Effect.die("unused editTicketFieldsUnlocked"),
            withBoardAdmissionLock: (_boardId, effect) => effect,
            runLane: () => Effect.die("unused runLane"),
            ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
            resolveApproval: () => Effect.die("unused resolveApproval"),
            answerTicketStep: () => Effect.void,
            postTicketMessage: () => Effect.void,
            editTicketMessage: () => Effect.void,
            cancelStep: () => Effect.die("unused cancelStep"),
            cancelBoardPipelines: () => Effect.void,
            cancelTicketPipelines: () => Effect.void,
            recoverBoardWip: (recoveredBoardId) =>
              Ref.update(recoveredBoards, (boards) => [...boards, recoveredBoardId as string]),
            completeRecoveredStep: () => Effect.die("unused completeRecoveredStep"),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkflowIds, {
            ticketId: () => Effect.succeed("ticket-unused" as never),
            pipelineRunId: () => Effect.succeed("pipeline-unused" as never),
            scriptRunId: () => Effect.succeed("script-unused" as never),
            stepRunId: () => Effect.succeed("step-unused" as never),
            messageId: () => Effect.succeed("message-unused" as never),
            eventId: () => Effect.succeed("event-unused" as never),
            token: () => Effect.succeed("token-unused" as never),
            mappingId: () => Effect.succeed("mapping-unused" as never),
          }),
        ),
        Layer.provideMerge(ApprovalGateLive),
        Layer.provideMerge(BoardRegistryLive),
        Layer.provideMerge(WorkflowFoundationLive),
        Layer.provideMerge(MigrationsLive),
        Layer.provideMerge(SqlitePersistenceMemory),
      );

      yield* Effect.gen(function* () {
        const recovery = yield* WorkflowRecovery;
        const registry = yield* BoardRegistry;
        const read = yield* WorkflowReadModel;
        const saveLocks = yield* WorkflowBoardSaveLocks;

        yield* registry.register(boardId, {
          name: "Preload Delete",
          lanes: [{ key: "impl", name: "Impl", entry: "manual" }],
        });
        yield* read.registerBoard({
          boardId,
          projectId,
          name: "Preload Delete",
          workflowFilePath: ".t3/boards/preload-delete.json",
          workflowVersionHash: "hash-preload-delete",
          maxConcurrentTickets: 1,
        });

        const deleteFiber = yield* saveLocks
          .withSaveLock(
            boardId,
            Effect.gen(function* () {
              yield* Deferred.succeed(deleteLockHeld, undefined);
              yield* Deferred.await(finishDelete);
              yield* fs.remove(boardPath);
              yield* registry.unregister(boardId);
              yield* read.deleteBoard(boardId);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(deleteLockHeld);

        const recoveryFiber = yield* recovery.recover().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const loaderEnteredWhileDeleteHeld = (yield* Ref.get(loadedBoards)).length > 0;

        yield* Deferred.succeed(finishDelete, undefined);
        yield* Fiber.join(deleteFiber);
        yield* Deferred.succeed(finishLoad, undefined).pipe(Effect.ignore);
        yield* Fiber.join(recoveryFiber).pipe(Effect.timeout("1 second"));

        assert.isFalse(loaderEnteredWhileDeleteHeld);
        assert.deepEqual(yield* Ref.get(loadedBoards), []);
        assert.deepEqual(yield* Ref.get(recoveredBoards), []);
        assert.isNull(yield* registry.getDefinition(boardId));
        assert.isNull(yield* read.getBoard(boardId));
      }).pipe(Effect.provide(preloadDeleteLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

layer("WorkflowRecovery", (it) => {
  it.effect("confirms recovered dispatches and completes terminal steps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* WorkflowRecovery;
      completedRecoveredSteps.length = 0;

      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-1',
          'project-1',
          'Recovery Board',
          '.t3/boards/recovery.json',
          'hash-recovery',
          3
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'ticket-1',
          'board-1',
          'Recover dispatch',
          'impl',
          'running',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:00.000Z'
        )
      `;
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
          created_at
        )
        VALUES (
          'dispatch-1',
          'ticket-1',
          'step-run-1',
          'thread-1',
          'codex',
          'gpt-5.5',
          'finish the step',
          '/tmp/wt-ticket-1',
          'pending',
          '2026-06-07T00:00:00.000Z'
        )
      `;

      yield* recovery.recover();

      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM workflow_dispatch_outbox WHERE dispatch_id = 'dispatch-1'
      `;
      assert.equal(rows[0]?.status, "confirmed");

      assert.deepEqual(completedRecoveredSteps, [
        {
          stepRunId: "step-run-1",
          result: { _tag: "completed" },
          captureTurn: { threadId: "thread-1", turnId: "turn-1" },
        },
      ]);
    }),
  );

  it.effect("releases worktree leases for steps that ended blocked", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* WorkflowRecovery;

      yield* sql`
        INSERT INTO workflow_events (
          event_id,
          ticket_id,
          stream_version,
          event_type,
          occurred_at,
          payload_json
        )
        VALUES (
          'evt-step-blocked',
          'ticket-blocked',
          0,
          'StepBlocked',
          '2026-06-07T00:00:00.000Z',
          '{"stepRunId":"step-run-blocked","reason":"Project not trusted to run scripts"}'
        )
      `;
      yield* sql`
        INSERT INTO worktree_lease (
          worktree_ref,
          owner_kind,
          owner_id,
          fence_token,
          acquired_at,
          expires_at
        )
        VALUES (
          'wt-blocked',
          'step',
          'step-run-blocked',
          7,
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:30:00.000Z'
        )
      `;

      yield* recovery.recover();

      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-blocked'
      `;
      assert.equal(rows[0]?.ownerKind, "released");
    }),
  );

  it.effect("fails running script runs after restart and releases their step lease", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* WorkflowRecovery;
      const registry = yield* BoardRegistry;
      const store = yield* WorkflowEventStore;

      yield* registry.register("board-script-recovery" as never, {
        name: "Script recovery",
        lanes: [{ key: "impl", name: "Impl", entry: "manual" }],
      });
      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-script-recovery',
          'project-script-recovery',
          'Script Recovery',
          '.t3/boards/script-recovery.json',
          'hash-script-recovery',
          3
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'ticket-script-recovery',
          'board-script-recovery',
          'Recover script',
          'impl',
          'running',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_events (
          event_id,
          ticket_id,
          stream_version,
          event_type,
          occurred_at,
          payload_json
        )
        VALUES
          (
            'evt-script-started',
            'ticket-script-recovery',
            0,
            'StepStarted',
            '2026-06-07T00:00:00.000Z',
            '{"pipelineRunId":"pipeline-script-recovery","stepRunId":"step-run-script-recovery","stepKey":"tests","stepType":"script"}'
          ),
          (
            'evt-script-run-started',
            'ticket-script-recovery',
            1,
            'ScriptStepStarted',
            '2026-06-07T00:00:01.000Z',
            '{"scriptRunId":"script-run-recovery","stepRunId":"step-run-script-recovery","scriptThreadId":"workflow-script:script-run-recovery","terminalId":"script-script-run-recovery"}'
          )
      `;
      yield* sql`
        INSERT INTO workflow_script_run (
          script_run_id,
          step_run_id,
          ticket_id,
          script_thread_id,
          terminal_id,
          status,
          started_at
        )
        VALUES (
          'script-run-recovery',
          'step-run-script-recovery',
          'ticket-script-recovery',
          'workflow-script:script-run-recovery',
          'script-script-run-recovery',
          'running',
          '2026-06-07T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO worktree_lease (
          worktree_ref,
          owner_kind,
          owner_id,
          fence_token,
          acquired_at,
          expires_at
        )
        VALUES (
          'wt-script-recovery',
          'step',
          'step-run-script-recovery',
          11,
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:30:00.000Z'
        )
      `;

      yield* recovery.recover();

      const scriptRows = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM workflow_script_run
        WHERE script_run_id = 'script-run-recovery'
      `;
      const leaseRows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-script-recovery'
      `;
      const events = yield* Stream.runCollect(
        store.readByTicket("ticket-script-recovery" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));

      assert.equal(scriptRows[0]?.status, "cancelled");
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "ScriptStepExited" &&
            event.payload.scriptRunId === "script-run-recovery" &&
            event.payload.outcome === "cancelled",
        ),
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "StepFailed" &&
            event.payload.stepRunId === "step-run-script-recovery" &&
            event.payload.error === "script interrupted by server restart",
        ),
      );
      assert.deepEqual(completedRecoveredSteps, [
        {
          stepRunId: "step-run-script-recovery",
          result: { _tag: "failed", error: "script interrupted by server restart" },
        },
      ]);
      assert.equal(leaseRows[0]?.ownerKind, "released");
    }),
  );

  it.effect("recovers an already-terminal merge step with its stored outcome", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* WorkflowRecovery;

      // Crash window: the StepCompleted event was appended but the crash hit
      // before the projection update, so the step run still says 'running'.
      yield* sql`
        INSERT INTO projection_step_run (
          step_run_id,
          pipeline_run_id,
          ticket_id,
          step_key,
          step_type,
          status,
          started_at
        )
        VALUES (
          'step-run-merge-terminal',
          'pipeline-merge-terminal',
          'ticket-merge-terminal',
          'land',
          'merge',
          'running',
          '2026-06-07T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_events (
          event_id,
          ticket_id,
          stream_version,
          event_type,
          occurred_at,
          payload_json
        )
        VALUES (
          'evt-merge-terminal-completed',
          'ticket-merge-terminal',
          0,
          'StepCompleted',
          '2026-06-07T00:00:01.000Z',
          '{"stepRunId":"step-run-merge-terminal","output":{"merged":true}}'
        )
      `;

      yield* recovery.recover();

      assert.deepEqual(completedRecoveredSteps, [
        {
          stepRunId: "step-run-merge-terminal",
          result: { _tag: "completed", output: { merged: true } },
        },
      ]);
    }),
  );

  // --- pullRequest step recovery ---------------------------------------------

  const prBoardDefinition = {
    name: "pr recovery",
    lanes: [
      {
        key: "ship",
        name: "Ship",
        entry: "auto",
        pipeline: [
          { key: "open-pr", type: "pullRequest", action: "open" },
          { key: "land-pr", type: "pullRequest", action: "land" },
        ],
      },
    ],
  };

  const seedPrStep = (input: {
    readonly boardId: string;
    readonly ticketId: string;
    readonly stepRunId: string;
    readonly stepKey: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const registry = yield* BoardRegistry;
      yield* registry.register(input.boardId as never, prBoardDefinition);
      yield* sql`
        INSERT INTO projection_board (
          board_id, project_id, name, workflow_file_path,
          workflow_version_hash, max_concurrent_tickets
        )
        VALUES (
          ${input.boardId}, ${`${input.boardId}-project`}, 'PR recovery',
          '.t3/boards/pr.json', ${`hash-${input.boardId}`}, 1
        )
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        )
        VALUES (
          ${`${input.boardId}-project`}, 'PR repo', '/tmp/pr-repo', '{}',
          '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES (
          ${input.ticketId}, ${input.boardId}, 'PR ticket', 'ship', 'running',
          '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_step_run (
          step_run_id, pipeline_run_id, ticket_id, step_key, step_type, status, started_at
        )
        VALUES (
          ${input.stepRunId}, ${`${input.stepRunId}-pipeline`}, ${input.ticketId},
          ${input.stepKey}, 'pullRequest', 'running', '2026-06-07T00:00:00.000Z'
        )
      `;
    });

  const seedPrStateRow = (ticketId: string, prNumber: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo, pr_state, updated_at
        )
        VALUES (
          ${ticketId}, ${prNumber}, ${`https://github.com/acme/widgets/pull/${prNumber}`},
          ${`workflow/${ticketId}`}, 'origin', 'acme/widgets', 'open', '2026-06-07T00:00:02.000Z'
        )
      `;
    });

  it.effect("recovers an open PR step from recorded PR state without adopting", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      gitHubPortScript.findPrForBranch = null;
      gitHubPortScript.findPrForBranchCalls = 0;
      const recovery = yield* WorkflowRecovery;

      yield* seedPrStep({
        boardId: "board-pr-open-recorded",
        ticketId: "ticket-pr-open-recorded",
        stepRunId: "step-run-pr-open-recorded",
        stepKey: "open-pr",
      });
      yield* seedPrStateRow("ticket-pr-open-recorded", 42);

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter(
        (c) => c.stepRunId === "step-run-pr-open-recorded",
      );
      assert.deepEqual(calls, [
        {
          stepRunId: "step-run-pr-open-recorded",
          result: {
            _tag: "completed",
            output: { prNumber: 42, url: "https://github.com/acme/widgets/pull/42" },
          },
        },
      ]);
      // PR already recorded → no branch lookup, no extra TicketPrOpened.
      assert.equal(gitHubPortScript.findPrForBranchCalls, 0);
      const events = yield* Stream.runCollect(
        (yield* WorkflowEventStore).readByTicket("ticket-pr-open-recorded" as never),
      );
      assert.equal(Array.from(events).filter((e) => e.type === "TicketPrOpened").length, 0);
    }),
  );

  it.effect("adopts a created-but-unrecorded PR and commits TicketPrOpened", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      gitHubPortScript.findPrForBranch = {
        number: 77,
        url: "https://github.com/acme/widgets/pull/77",
      };
      gitHubPortScript.findPrForBranchCalls = 0;
      const recovery = yield* WorkflowRecovery;

      yield* seedPrStep({
        boardId: "board-pr-open-adopt",
        ticketId: "ticket-pr-open-adopt",
        stepRunId: "step-run-pr-open-adopt",
        stepKey: "open-pr",
      });

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter((c) => c.stepRunId === "step-run-pr-open-adopt");
      assert.deepEqual(calls, [
        {
          stepRunId: "step-run-pr-open-adopt",
          result: {
            _tag: "completed",
            output: { prNumber: 77, url: "https://github.com/acme/widgets/pull/77" },
          },
        },
      ]);
      assert.isAtLeast(gitHubPortScript.findPrForBranchCalls, 1);
      const events = yield* Stream.runCollect(
        (yield* WorkflowEventStore).readByTicket("ticket-pr-open-adopt" as never),
      );
      const opened = Array.from(events).filter((e) => e.type === "TicketPrOpened");
      assert.equal(opened.length, 1);
      assert.equal((opened[0] as { payload: { prNumber: number } }).payload.prNumber, 77);
    }),
  );

  it.effect("fails an open PR step when no PR exists on the remote", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      gitHubPortScript.findPrForBranch = null;
      const recovery = yield* WorkflowRecovery;

      yield* seedPrStep({
        boardId: "board-pr-open-none",
        ticketId: "ticket-pr-open-none",
        stepRunId: "step-run-pr-open-none",
        stepKey: "open-pr",
      });

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter((c) => c.stepRunId === "step-run-pr-open-none");
      assert.deepEqual(calls, [
        {
          stepRunId: "step-run-pr-open-none",
          result: { _tag: "failed", error: "PR open interrupted by restart" },
        },
      ]);
    }),
  );

  it.effect("completes a land PR step when prDetail reports merged", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      gitHubPortScript.prDetailState = "merged";
      const recovery = yield* WorkflowRecovery;

      yield* seedPrStep({
        boardId: "board-pr-land-merged",
        ticketId: "ticket-pr-land-merged",
        stepRunId: "step-run-pr-land-merged",
        stepKey: "land-pr",
      });
      yield* seedPrStateRow("ticket-pr-land-merged", 55);

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter(
        (c) => c.stepRunId === "step-run-pr-land-merged",
      );
      assert.deepEqual(calls, [
        { stepRunId: "step-run-pr-land-merged", result: { _tag: "completed" } },
      ]);
    }),
  );

  it.effect("fails a land PR step when prDetail reports not merged", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      gitHubPortScript.prDetailState = "open";
      const recovery = yield* WorkflowRecovery;

      yield* seedPrStep({
        boardId: "board-pr-land-open",
        ticketId: "ticket-pr-land-open",
        stepRunId: "step-run-pr-land-open",
        stepKey: "land-pr",
      });
      yield* seedPrStateRow("ticket-pr-land-open", 56);

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter((c) => c.stepRunId === "step-run-pr-land-open");
      assert.deepEqual(calls, [
        {
          stepRunId: "step-run-pr-land-open",
          result: { _tag: "failed", error: "land interrupted by restart" },
        },
      ]);
    }),
  );

  it.effect("fails a land PR step when no PR state is recorded", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      const recovery = yield* WorkflowRecovery;

      yield* seedPrStep({
        boardId: "board-pr-land-norow",
        ticketId: "ticket-pr-land-norow",
        stepRunId: "step-run-pr-land-norow",
        stepKey: "land-pr",
      });

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter((c) => c.stepRunId === "step-run-pr-land-norow");
      assert.deepEqual(calls, [
        {
          stepRunId: "step-run-pr-land-norow",
          result: { _tag: "failed", error: "land interrupted by restart" },
        },
      ]);
    }),
  );

  it.effect("fails a running step whose outbox rows were confirmed before the terminal event", () =>
    Effect.gen(function* () {
      completedRecoveredSteps.length = 0;
      const sql = yield* SqlClient.SqlClient;
      const recovery = yield* WorkflowRecovery;

      // Crash window: awaitTerminal confirmed the dispatch row (e.g. on its
      // 30-minute timeout) but the process died before the engine committed
      // the step's terminal event. No dispatch stage looks at confirmed rows
      // and the projection still says 'running' with no terminal event.
      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-confirmed-crash',
          'project-confirmed-crash',
          'Confirmed Crash',
          '.t3/boards/confirmed-crash.json',
          'hash-confirmed-crash',
          1
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'ticket-confirmed-crash',
          'board-confirmed-crash',
          'Confirmed crash',
          'impl',
          'running',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_step_run (
          step_run_id,
          pipeline_run_id,
          ticket_id,
          step_key,
          step_type,
          status,
          started_at
        )
        VALUES (
          'step-confirmed-crash',
          'pipeline-confirmed-crash',
          'ticket-confirmed-crash',
          'implement',
          'agent',
          'running',
          '2026-06-07T00:00:00.000Z'
        )
      `;
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
          started_at,
          confirmed_at
        )
        VALUES (
          'dispatch-confirmed-crash',
          'ticket-confirmed-crash',
          'step-confirmed-crash',
          'thread-confirmed-crash',
          'codex',
          'gpt-5.5',
          'implement the step',
          '/tmp/confirmed-crash',
          'confirmed',
          'turn-confirmed-crash',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:01.000Z'
        )
      `;

      yield* recovery.recover();

      const calls = completedRecoveredSteps.filter(
        (call) => call.stepRunId === "step-confirmed-crash",
      );
      assert.deepEqual(calls, [
        {
          stepRunId: "step-confirmed-crash",
          result: { _tag: "failed", error: "step interrupted by server restart" },
        },
      ]);
    }),
  );
});
