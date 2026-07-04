import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowThreadJanitor } from "../Services/WorkflowThreadJanitor.ts";
import { WorkflowTerminalRetentionSweeper } from "../Services/WorkflowTerminalRetentionSweeper.ts";
import { WorkflowWorktreeJanitor } from "../Services/WorkflowWorktreeJanitor.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";
import { makeWorkflowTerminalRetentionSweeperLive } from "./WorkflowTerminalRetentionSweeper.ts";

const unsupported = () => Effect.die("unsupported workflow engine call") as never;

const EngineStub = Layer.succeed(WorkflowEngine, {
  createTicket: () => unsupported(),
  editTicket: () => unsupported(),
  moveTicket: () => unsupported(),
  createTicketAndEnterUnlocked: () => unsupported(),
  closeTicketFromSourceUnlocked: () => unsupported(),
  reopenTicketFromSourceUnlocked: () => unsupported(),
  cancellableProviderTurnsForTicket: () => unsupported(),
  supersedeProviderWorkForTicket: () => unsupported(),
  terminalAgentSessionThreadsForTicket: () => unsupported(),
  stopAgentSessionsForTicket: () => unsupported(),
  editTicketFieldsUnlocked: () => unsupported(),
  withBoardAdmissionLock: (_boardId, effect) => effect,
  runLane: () => unsupported(),
  ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
  resolveApproval: () => unsupported(),
  answerTicketStep: () => unsupported(),
  postTicketMessage: () => unsupported(),
  editTicketMessage: () => unsupported(),
  cancelStep: () => unsupported(),
  cancelBoardPipelines: () => Effect.void,
  cancelTicketPipelines: () => Effect.void,
  recoverBoardWip: () => Effect.void,
  completeRecoveredStep: () => unsupported(),
} satisfies WorkflowEngineShape);

const makeJanitorAwareLayer = (events: string[]) =>
  makeWorkflowTerminalRetentionSweeperLive({
    sweepIntervalMs: 60_000,
    nowMs: Effect.succeed(Date.parse("2026-06-08T00:00:00.000Z")),
  }).pipe(
    Layer.provideMerge(EngineStub),
    Layer.provideMerge(
      Layer.succeed(WorkflowWorktreeJanitor, {
        collectBoardPlan: () => Effect.die("unexpected board worktree cleanup"),
        collectTicketPlan: (ticketId) =>
          Effect.sync(() => {
            events.push(`worktree-collect:${ticketId as string}`);
            return { repoRoot: "/repo", ticketIds: [ticketId] };
          }),
        run: (plan) =>
          Effect.sync(() => {
            events.push(`worktree-run:${plan?.ticketIds.join(",") ?? "none"}`);
          }),
      } satisfies WorkflowWorktreeJanitor["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowThreadJanitor, {
        collectBoardThreads: () => Effect.die("unexpected board thread cleanup"),
        collectTicketThreads: (ticketId) =>
          Effect.sync(() => {
            events.push(`thread-collect:${ticketId as string}`);
            return [`thread-${ticketId as string}`];
          }),
        deleteThreads: (threadIds) =>
          Effect.sync(() => {
            events.push(`thread-delete:${threadIds.join(",")}`);
          }),
      } satisfies WorkflowThreadJanitor["Service"]),
    ),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(WorkflowEventStoreLive),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const layer = it.layer(
  makeWorkflowTerminalRetentionSweeperLive({
    sweepIntervalMs: 60_000,
    nowMs: Effect.succeed(Date.parse("2026-06-08T00:00:00.000Z")),
  }).pipe(
    Layer.provideMerge(EngineStub),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(WorkflowEventStoreLive),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const registerRetentionBoard = Effect.gen(function* () {
  const registry = yield* BoardRegistry;
  yield* registry.register("board-retention" as never, {
    name: "retention sweep",
    lanes: [
      { key: "backlog", name: "Backlog", entry: "manual" },
      {
        key: "done",
        name: "Done",
        entry: "manual",
        terminal: true,
        retention: "1 day",
      },
    ],
  });
});

const seedTicket = (input: { readonly ticketId: string; readonly terminalAt: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* WorkflowEventStore;
    const now = "2026-06-08T00:00:00.000Z";

    yield* sql`
      INSERT INTO p_workflow_boards_projection_ticket (
        ticket_id, board_id, title, current_lane_key, status, terminal_at, created_at, updated_at
      ) VALUES (
        ${input.ticketId}, 'board-retention', ${input.ticketId}, 'done', 'done',
        ${input.terminalAt}, ${now}, ${now}
      )
    `;
    yield* sql`
      INSERT INTO p_workflow_boards_projection_pipeline_run (
        pipeline_run_id, ticket_id, lane_key, lane_entry_token, status, started_at
      ) VALUES (${`pipeline-${input.ticketId}`}, ${input.ticketId}, 'done', ${`token-${input.ticketId}`}, 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO p_workflow_boards_projection_step_run (
        step_run_id, pipeline_run_id, ticket_id, step_key, step_type, status, started_at
      ) VALUES (${`step-${input.ticketId}`}, ${`pipeline-${input.ticketId}`}, ${input.ticketId}, 'cleanup', 'script', 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO p_workflow_boards_dispatch_outbox (
        dispatch_id, ticket_id, step_run_id, thread_id, provider_instance, model, instruction,
        worktree_path, status, created_at
      ) VALUES (${`dispatch-${input.ticketId}`}, ${input.ticketId}, ${`step-${input.ticketId}`}, ${`thread-${input.ticketId}`}, 'codex', 'gpt-5.5', 'cleanup', ${`/tmp/${input.ticketId}`}, 'completed', ${now})
    `;
    yield* store.append({
      type: "TicketCreated",
      eventId: `event-${input.ticketId}` as never,
      ticketId: input.ticketId as never,
      occurredAt: now as never,
      payload: {
        boardId: "board-retention" as never,
        title: input.ticketId as never,
        laneKey: "done" as never,
      },
    });
  });

const ticketOwnedRowCount = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM p_workflow_boards_projection_ticket WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM p_workflow_boards_projection_pipeline_run WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM p_workflow_boards_projection_step_run WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM p_workflow_boards_dispatch_outbox WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM p_workflow_boards_events WHERE ticket_id = ${ticketId}
    `;
    return rows.reduce((total, row) => total + row.count, 0);
  });

layer("WorkflowTerminalRetentionSweeper", (it) => {
  it.effect("deletes expired terminal tickets and keeps fresh terminal tickets", () =>
    Effect.gen(function* () {
      const sweeper = yield* WorkflowTerminalRetentionSweeper;

      yield* registerRetentionBoard;
      yield* seedTicket({
        ticketId: "ticket-expired",
        terminalAt: "2026-06-06T00:00:00.000Z",
      });
      yield* seedTicket({
        ticketId: "ticket-fresh",
        terminalAt: "2026-06-07T12:00:00.000Z",
      });

      const result = yield* sweeper.sweep();

      assert.equal(result.deletedCount, 1);
      assert.equal(yield* ticketOwnedRowCount("ticket-expired"), 0);
      assert.equal(yield* ticketOwnedRowCount("ticket-fresh"), 5);
    }),
  );
});

it.effect("runtime wiring provides retention sweeps with worktree and thread janitors", () => {
  const events: string[] = [];
  return Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;

    yield* registerRetentionBoard;
    yield* seedTicket({
      ticketId: "ticket-expired-runtime",
      terminalAt: "2026-06-06T00:00:00.000Z",
    });

    const result = yield* sweeper.sweep();

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(events, [
      "worktree-collect:ticket-expired-runtime",
      "thread-collect:ticket-expired-runtime",
      "worktree-run:ticket-expired-runtime",
      "thread-delete:thread-ticket-expired-runtime",
    ]);
  }).pipe(Effect.provide(makeJanitorAwareLayer(events)));
});
