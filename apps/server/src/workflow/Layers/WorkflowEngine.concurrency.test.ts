import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionNotFoundError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const definition = {
  name: "limited",
  settings: { maxConcurrentTickets: 1 },
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
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

let activeExecutions = 0;
let maxActiveExecutions = 0;

const countingExecutor = Layer.succeed(StepExecutor, {
  execute: () =>
    Effect.gen(function* () {
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      yield* Effect.sleep("20 millis");
      activeExecutions -= 1;
      return { _tag: "completed" as const };
    }),
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
    Layer.provideMerge(countingExecutor),
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

layer("WorkflowEngine concurrency", (it) => {
  it.effect("caps simultaneously running tickets per board", () =>
    Effect.gen(function* () {
      activeExecutions = 0;
      maxActiveExecutions = 0;

      const registry = yield* BoardRegistry;
      yield* registry.register("b-limit" as never, definition);
      const engine = yield* WorkflowEngine;

      yield* Effect.all(
        [
          engine.createTicket({
            boardId: "b-limit" as never,
            title: "First",
            initialLane: "impl" as never,
          }),
          engine.createTicket({
            boardId: "b-limit" as never,
            title: "Second",
            initialLane: "impl" as never,
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(maxActiveExecutions, 1);
    }),
  );

  it.effect("applies a raised maxConcurrentTickets without a server restart", () =>
    Effect.gen(function* () {
      activeExecutions = 0;
      maxActiveExecutions = 0;

      const registry = yield* BoardRegistry;
      yield* registry.register("b-resize" as never, definition);
      const engine = yield* WorkflowEngine;

      yield* Effect.all(
        [
          engine.createTicket({
            boardId: "b-resize" as never,
            title: "First",
            initialLane: "impl" as never,
          }),
          engine.createTicket({
            boardId: "b-resize" as never,
            title: "Second",
            initialLane: "impl" as never,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(maxActiveExecutions, 1);

      // Saving the definition with a higher limit must take effect for the
      // very next pipeline — not only after a restart.
      yield* registry.register("b-resize" as never, {
        ...definition,
        settings: { maxConcurrentTickets: 2 },
      });
      activeExecutions = 0;
      maxActiveExecutions = 0;

      yield* Effect.all(
        [
          engine.createTicket({
            boardId: "b-resize" as never,
            title: "Third",
            initialLane: "impl" as never,
          }),
          engine.createTicket({
            boardId: "b-resize" as never,
            title: "Fourth",
            initialLane: "impl" as never,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(maxActiveExecutions, 2);
    }),
  );

  it.effect("rejects createTicket that races after a board delete under the save lock", () =>
    Effect.gen(function* () {
      const boardId = "b-delete-race" as never;
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const eventStore = yield* WorkflowEventStore;
      const saveLocks = yield* WorkflowBoardSaveLocks;
      const sql = yield* SqlClient.SqlClient;
      const deleteReady = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();

      yield* registry.register(boardId, {
        name: "delete-race",
        lanes: [{ key: "todo", name: "Todo", entry: "manual" }],
      });

      const deleteFiber = yield* saveLocks
        .withSaveLock(
          boardId,
          Effect.gen(function* () {
            yield* registry.unregister(boardId);
            yield* eventStore.deleteForBoard(boardId);
            yield* Deferred.succeed(deleteReady, undefined);
            yield* Deferred.await(releaseDelete);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(deleteReady);
      const createFiber = yield* engine
        .createTicket({
          boardId,
          title: "Should not survive",
          initialLane: "todo" as never,
        })
        .pipe(Effect.exit, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseDelete, undefined);
      yield* Fiber.join(deleteFiber);

      const createResult = yield* Fiber.join(createFiber);
      assert.isTrue(Exit.isFailure(createResult));

      const counts = yield* sql<{ readonly tableName: string; readonly count: number }>`
        SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
        FROM projection_ticket
        WHERE board_id = ${boardId}
        UNION ALL
        SELECT 'workflow_events' AS tableName, COUNT(*) AS count
        FROM workflow_events
        WHERE json_extract(payload_json, '$.boardId') = ${boardId}
      `;

      assert.deepEqual(
        counts.map((row) => [row.tableName, row.count]),
        [
          ["projection_ticket", 0],
          ["workflow_events", 0],
        ],
      );
    }),
  );

  it.effect("does not orphan ticket messages when answerTicketStep races board delete", () =>
    Effect.gen(function* () {
      const boardId = "b-answer-delete-race" as never;
      const ticketId = "ticket-answer-delete-race" as never;
      const stepRunId = "step-answer-delete-race" as never;
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const eventStore = yield* WorkflowEventStore;
      const saveLocks = yield* WorkflowBoardSaveLocks;
      const sql = yield* SqlClient.SqlClient;
      const deleteReady = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();

      yield* registry.register(boardId, definition);
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
          ${ticketId},
          ${boardId},
          'Delete race',
          'impl',
          'waiting_on_user',
          '2026-06-08T00:00:00.000Z',
          '2026-06-08T00:00:00.000Z'
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
          waiting_reason,
          provider_response_kind,
          started_at
        )
        VALUES (
          ${stepRunId},
          'pipeline-answer-delete-race',
          ${ticketId},
          'code',
          'agent',
          'awaiting_user',
          'Need answer',
          'user-input',
          '2026-06-08T00:00:00.000Z'
        )
      `;

      const deleteFiber = yield* saveLocks
        .withSaveLock(
          boardId,
          Effect.gen(function* () {
            yield* registry.unregister(boardId);
            yield* eventStore.deleteForBoard(boardId);
            yield* sql`DELETE FROM projection_ticket WHERE board_id = ${boardId}`;
            yield* Deferred.succeed(deleteReady, undefined);
            yield* Deferred.await(releaseDelete);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(deleteReady);
      const answerFiber = yield* engine
        .answerTicketStep({
          stepRunId,
          text: "Use the sandbox endpoint.",
          attachments: [],
        })
        .pipe(Effect.exit, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseDelete, undefined);
      yield* Fiber.join(deleteFiber);

      const answerResult = yield* Fiber.join(answerFiber);
      assert.isTrue(Exit.isSuccess(answerResult));

      const counts = yield* sql<{ readonly tableName: string; readonly count: number }>`
        SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
        FROM projection_ticket
        WHERE board_id = ${boardId}
        UNION ALL
        SELECT 'projection_ticket_message' AS tableName, COUNT(*) AS count
        FROM projection_ticket_message
        WHERE ticket_id = ${ticketId}
        UNION ALL
        SELECT 'workflow_events' AS tableName, COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id = ${ticketId}
      `;

      assert.deepEqual(
        counts.map((row) => [row.tableName, row.count]),
        [
          ["projection_ticket", 0],
          ["projection_ticket_message", 0],
          ["workflow_events", 0],
        ],
      );
    }),
  );
});

it.effect("cancelBoardPipelines interrupts and stops active provider turns for board tickets", () =>
  Effect.gen(function* () {
    const providerCalls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const testLayer = WorkflowEngineLayer.pipe(
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(countingExecutor),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowRoutingContextBuilderLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(ProviderService, {
          startSession: () => Effect.die("unused"),
          sendTurn: () => Effect.die("unused"),
          interruptTurn: (input) =>
            Ref.update(providerCalls, (calls) => [...calls, { kind: "interrupt", input }]),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: (input) =>
            Ref.update(providerCalls, (calls) => [...calls, { kind: "stop", input }]),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        } satisfies ProviderServiceShape),
      ),
      Layer.provideMerge(DeterministicWorkflowIds),
      Layer.provideMerge(WorkflowFoundationLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

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
          ('ticket-active-provider', 'board-provider-cancel', 'Active provider', 'impl', 'running', ${now}, ${now}),
          ('ticket-other-provider', 'board-other-provider', 'Other provider', 'impl', 'running', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          turn_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at,
          started_at
        )
        VALUES
          ('dispatch-active-provider', 'ticket-active-provider', 'step-active-provider', 'thread-active-provider', 'turn-active-provider', 'codex', 'gpt-5.5', 'cancel me', '/tmp/active-provider', 'started', ${now}, ${now}),
          ('dispatch-other-provider', 'ticket-other-provider', 'step-other-provider', 'thread-other-provider', 'turn-other-provider', 'codex', 'gpt-5.5', 'keep me', '/tmp/other-provider', 'started', ${now}, ${now}),
          ('dispatch-pending-provider', 'ticket-active-provider', 'step-pending-provider', 'thread-pending-provider', NULL, 'codex', 'gpt-5.5', 'not started', '/tmp/pending-provider', 'pending', ${now}, NULL)
      `;

      yield* engine
        .cancelBoardPipelines("board-provider-cancel" as never)
        .pipe(Effect.timeout("1 second"));

      assert.deepEqual(yield* Ref.get(providerCalls), [
        {
          kind: "interrupt",
          input: {
            threadId: "thread-active-provider",
            turnId: "turn-active-provider",
          },
        },
        {
          kind: "stop",
          input: {
            threadId: "thread-active-provider",
          },
        },
        {
          kind: "stop",
          input: {
            threadId: "thread-pending-provider",
          },
        },
      ]);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("cancelTicketPipelines interrupts and stops active provider turns for one ticket", () =>
  Effect.gen(function* () {
    const providerCalls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const testLayer = WorkflowEngineLayer.pipe(
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(countingExecutor),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowRoutingContextBuilderLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(ProviderService, {
          startSession: () => Effect.die("unused"),
          sendTurn: () => Effect.die("unused"),
          interruptTurn: (input) =>
            Ref.update(providerCalls, (calls) => [...calls, { kind: "interrupt", input }]),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: (input) =>
            Ref.update(providerCalls, (calls) => [...calls, { kind: "stop", input }]),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        } satisfies ProviderServiceShape),
      ),
      Layer.provideMerge(DeterministicWorkflowIds),
      Layer.provideMerge(WorkflowFoundationLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

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
          ('ticket-provider-delete-one', 'board-provider-delete-one', 'Delete provider', 'impl', 'running', ${now}, ${now}),
          ('ticket-provider-keep-one', 'board-provider-delete-one', 'Keep provider', 'impl', 'running', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          turn_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at,
          started_at
        )
        VALUES
          ('dispatch-provider-delete-one', 'ticket-provider-delete-one', 'step-provider-delete-one', 'thread-provider-delete-one', 'turn-provider-delete-one', 'codex', 'gpt-5.5', 'cancel me', '/tmp/delete-one', 'started', ${now}, ${now}),
          ('dispatch-provider-keep-one', 'ticket-provider-keep-one', 'step-provider-keep-one', 'thread-provider-keep-one', 'turn-provider-keep-one', 'codex', 'gpt-5.5', 'keep me', '/tmp/keep-one', 'started', ${now}, ${now}),
          ('dispatch-provider-pending-one', 'ticket-provider-delete-one', 'step-provider-pending-one', 'thread-provider-pending-one', NULL, 'codex', 'gpt-5.5', 'not started', '/tmp/pending-one', 'pending', ${now}, NULL)
      `;

      yield* engine
        .cancelTicketPipelines("ticket-provider-delete-one" as never)
        .pipe(Effect.timeout("1 second"));

      assert.deepEqual(yield* Ref.get(providerCalls), [
        {
          kind: "interrupt",
          input: {
            threadId: "thread-provider-delete-one",
            turnId: "turn-provider-delete-one",
          },
        },
        {
          kind: "stop",
          input: {
            threadId: "thread-provider-delete-one",
          },
        },
        {
          kind: "stop",
          input: {
            threadId: "thread-provider-pending-one",
          },
        },
      ]);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("cancelBoardPipelines treats already-stopped provider sessions as cleanup success", () =>
  Effect.gen(function* () {
    const providerCalls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const testLayer = WorkflowEngineLayer.pipe(
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(countingExecutor),
      Layer.provideMerge(ApprovalGateLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(PredicateEvaluatorLive),
      Layer.provideMerge(WorkflowRoutingContextBuilderLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(
        Layer.succeed(ProviderService, {
          startSession: () => Effect.die("unused"),
          sendTurn: () => Effect.die("unused"),
          interruptTurn: (input) =>
            Ref.update(providerCalls, (calls) => [...calls, { kind: "interrupt", input }]).pipe(
              Effect.andThen(
                Effect.fail(new ProviderSessionNotFoundError({ threadId: input.threadId })),
              ),
            ),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: (input) =>
            Ref.update(providerCalls, (calls) => [...calls, { kind: "stop", input }]).pipe(
              Effect.andThen(
                Effect.fail(new ProviderSessionNotFoundError({ threadId: input.threadId })),
              ),
            ),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        } satisfies ProviderServiceShape),
      ),
      Layer.provideMerge(DeterministicWorkflowIds),
      Layer.provideMerge(WorkflowFoundationLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

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
          'ticket-stale-provider',
          'board-stale-provider',
          'Stale provider',
          'impl',
          'running',
          ${now},
          ${now}
        )
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          turn_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at,
          started_at
        )
        VALUES (
          'dispatch-stale-provider',
          'ticket-stale-provider',
          'step-stale-provider',
          'thread-stale-provider',
          'turn-stale-provider',
          'codex',
          'gpt-5.5',
          'already gone',
          '/tmp/stale-provider',
          'started',
          ${now},
          ${now}
        )
      `;

      yield* engine
        .cancelBoardPipelines("board-stale-provider" as never)
        .pipe(Effect.timeout("1 second"));

      assert.deepEqual(yield* Ref.get(providerCalls), [
        {
          kind: "interrupt",
          input: {
            threadId: "thread-stale-provider",
            turnId: "turn-stale-provider",
          },
        },
        {
          kind: "stop",
          input: {
            threadId: "thread-stale-provider",
          },
        },
      ]);
    }).pipe(Effect.provide(testLayer));
  }),
);
