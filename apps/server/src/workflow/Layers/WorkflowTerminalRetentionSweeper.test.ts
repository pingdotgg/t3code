import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import type { WorkflowBoardVersionStoreShape } from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowTerminalRetentionSweeper } from "../Services/WorkflowTerminalRetentionSweeper.ts";
import { deleteWorkflowBoardOwnedState } from "../boardDeletion.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";
import { makeWorkflowTerminalRetentionSweeperLive } from "./WorkflowTerminalRetentionSweeper.ts";

const unsupported = () => Effect.die("unsupported workflow engine call") as never;
type TestSaveLocksLayer = Layer.Layer<WorkflowBoardSaveLocks, never, SqlClient.SqlClient>;

const makeEngineLayer = (
  cancelTicketPipelines: WorkflowEngineShape["cancelTicketPipelines"] = () => Effect.void,
) =>
  Layer.succeed(WorkflowEngine, {
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
    cancelTicketPipelines,
    recoverBoardWip: () => Effect.void,
    completeRecoveredStep: () => unsupported(),
  } satisfies WorkflowEngineShape);

const makeSaveLocksLayer = (
  beforeSaveLock: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError>,
) =>
  Layer.effect(
    WorkflowBoardSaveLocks,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        withSaveLock: (_boardId, effect) =>
          Effect.gen(function* () {
            yield* beforeSaveLock(sql).pipe(Effect.orDie);
            return yield* effect;
          }),
      } satisfies WorkflowBoardSaveLocks["Service"];
    }),
  );

const makeLayer = ({
  cancelTicketPipelines,
  maxDeletesPerSweep,
  saveLocksLayer = WorkflowBoardSaveLocksLive as TestSaveLocksLayer,
}: {
  readonly cancelTicketPipelines?: WorkflowEngineShape["cancelTicketPipelines"];
  readonly maxDeletesPerSweep?: number;
  readonly saveLocksLayer?: TestSaveLocksLayer;
} = {}) =>
  makeWorkflowTerminalRetentionSweeperLive({
    sweepIntervalMs: 60_000,
    ...(maxDeletesPerSweep === undefined ? {} : { maxDeletesPerSweep }),
    nowMs: Effect.succeed(Date.parse("2026-06-08T00:00:00.000Z")),
  }).pipe(
    Layer.provideMerge(makeEngineLayer(cancelTicketPipelines)),
    Layer.provideMerge(saveLocksLayer),
    Layer.provideMerge(WorkflowEventStoreLive),
    Layer.provideMerge(WorkflowReadModelLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const registerRetentionBoardFor = (boardId: string) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    yield* registry.register(boardId as never, {
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
        { key: "archive", name: "Archive", entry: "manual", terminal: true },
      ],
    });
  });

const registerRetentionBoard = registerRetentionBoardFor("board-retention-sweep");

const seedTicket = (input: {
  readonly boardId?: string;
  readonly ticketId: string;
  readonly lane: string;
  readonly status?: string;
  readonly terminalAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* WorkflowEventStore;
    const now = "2026-06-08T00:00:00.000Z";

    yield* sql`
      INSERT INTO projection_ticket (
        ticket_id,
        board_id,
        title,
        current_lane_key,
        status,
        terminal_at,
        created_at,
        updated_at
      )
      VALUES (
        ${input.ticketId},
        ${input.boardId ?? "board-retention-sweep"},
        ${input.ticketId},
        ${input.lane},
        ${input.status ?? "done"},
        ${input.terminalAt},
        ${now},
        ${now}
      )
    `;
    yield* sql`
      INSERT INTO projection_pipeline_run (
        pipeline_run_id,
        ticket_id,
        lane_key,
        lane_entry_token,
        status,
        started_at
      )
      VALUES (${`pipeline-${input.ticketId}`}, ${input.ticketId}, ${input.lane}, ${`token-${input.ticketId}`}, 'completed', ${now})
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
      VALUES (${`step-${input.ticketId}`}, ${`pipeline-${input.ticketId}`}, ${input.ticketId}, 'cleanup', 'script', 'completed', ${now})
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
      VALUES (${`script-${input.ticketId}`}, ${`step-${input.ticketId}`}, ${input.ticketId}, ${`thread-${input.ticketId}`}, ${`terminal-${input.ticketId}`}, 'completed', ${now})
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
      VALUES (${`dispatch-${input.ticketId}`}, ${input.ticketId}, ${`step-${input.ticketId}`}, ${`thread-${input.ticketId}`}, 'codex', 'gpt-5.5', 'cleanup', ${`/tmp/${input.ticketId}`}, 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO workflow_setup_run (
        setup_run_id,
        ticket_id,
        worktree_ref,
        status,
        started_at
      )
      VALUES (${`setup-${input.ticketId}`}, ${input.ticketId}, ${`worktree-${input.ticketId}`}, 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO projection_ticket_message (
        message_id,
        ticket_id,
        step_run_id,
        author,
        body,
        attachments_json,
        created_at
      )
      VALUES (${`message-${input.ticketId}`}, ${input.ticketId}, ${`step-${input.ticketId}`}, 'user', 'cleanup', '[]', ${now})
    `;
    yield* store.append({
      type: "TicketCreated",
      eventId: `event-${input.ticketId}` as never,
      ticketId: input.ticketId as never,
      occurredAt: now as never,
      payload: {
        boardId: (input.boardId ?? "board-retention-sweep") as never,
        title: input.ticketId as never,
        laneKey: input.lane as never,
      },
    });
  });

const ticketOwnedRowCount = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_ticket WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM projection_pipeline_run WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM projection_step_run WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM workflow_script_run WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM workflow_dispatch_outbox WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM workflow_setup_run WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM projection_ticket_message WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM workflow_events WHERE ticket_id = ${ticketId}
    `;
    return rows.reduce((total, row) => total + row.count, 0);
  });

const remainingTicketCountForBoard = (boardId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_ticket
      WHERE board_id = ${boardId}
    `;
    return rows[0]?.count ?? 0;
  });

it.effect("deletes expired terminal tickets and keeps fresh or no-retention terminal tickets", () =>
  Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;

    yield* registerRetentionBoard;
    yield* seedTicket({
      ticketId: "ticket-expired",
      lane: "done",
      terminalAt: "2026-06-06T00:00:00.000Z",
    });
    yield* seedTicket({
      ticketId: "ticket-fresh",
      lane: "done",
      terminalAt: "2026-06-07T12:00:00.000Z",
    });
    yield* seedTicket({
      ticketId: "ticket-no-retention",
      lane: "archive",
      terminalAt: "2026-06-01T00:00:00.000Z",
    });

    const result = yield* sweeper.sweep();

    assert.equal(result.deletedCount, 1);
    assert.equal(yield* ticketOwnedRowCount("ticket-expired"), 0);
    assert.equal(yield* ticketOwnedRowCount("ticket-fresh"), 8);
    assert.equal(yield* ticketOwnedRowCount("ticket-no-retention"), 8);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("skips expired terminal tickets while their workflow status is active", () =>
  Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;
    const activeStatuses = ["running", "waiting_on_user", "blocked", "queued"] as const;

    yield* registerRetentionBoard;
    for (const status of activeStatuses) {
      yield* seedTicket({
        ticketId: `ticket-active-${status}`,
        lane: "done",
        status,
        terminalAt: "2026-06-06T00:00:00.000Z",
      });
    }

    const result = yield* sweeper.sweep();

    assert.equal(result.candidateCount, 0);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.failedCount, 0);
    for (const status of activeStatuses) {
      assert.equal(yield* ticketOwnedRowCount(`ticket-active-${status}`), 8);
    }
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("deletes expired terminal tickets after their workflow status is settled", () =>
  Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;
    const settledStatuses = ["idle", "done", "failed"] as const;

    yield* registerRetentionBoard;
    for (const status of settledStatuses) {
      yield* seedTicket({
        ticketId: `ticket-settled-${status}`,
        lane: "done",
        status,
        terminalAt: "2026-06-06T00:00:00.000Z",
      });
    }

    const result = yield* sweeper.sweep();

    assert.equal(result.candidateCount, 3);
    assert.equal(result.deletedCount, 3);
    assert.equal(result.failedCount, 0);
    for (const status of settledStatuses) {
      assert.equal(yield* ticketOwnedRowCount(`ticket-settled-${status}`), 0);
    }
  }).pipe(Effect.provide(makeLayer())),
);

it.effect(
  "keeps tickets exactly at the retention boundary and deletes strictly older tickets",
  () =>
    Effect.gen(function* () {
      const sweeper = yield* WorkflowTerminalRetentionSweeper;

      yield* registerRetentionBoard;
      yield* seedTicket({
        ticketId: "ticket-boundary",
        lane: "done",
        terminalAt: "2026-06-07T00:00:00.000Z",
      });
      yield* seedTicket({
        ticketId: "ticket-one-ms-expired",
        lane: "done",
        terminalAt: "2026-06-06T23:59:59.999Z",
      });

      const result = yield* sweeper.sweep();

      assert.equal(result.candidateCount, 1);
      assert.equal(result.deletedCount, 1);
      assert.equal(yield* ticketOwnedRowCount("ticket-boundary"), 8);
      assert.equal(yield* ticketOwnedRowCount("ticket-one-ms-expired"), 0);
    }).pipe(Effect.provide(makeLayer())),
);

it.effect("skips a selected ticket that moves out of the terminal lane before delete lock", () => {
  let movedCandidate = false;

  return Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;
    const sql = yield* SqlClient.SqlClient;

    yield* registerRetentionBoard;
    yield* seedTicket({
      ticketId: "ticket-stale-candidate",
      lane: "done",
      terminalAt: "2026-06-06T00:00:00.000Z",
    });

    const result = yield* sweeper.sweep();
    const rows = yield* sql<{ readonly lane: string; readonly terminalAt: string | null }>`
      SELECT current_lane_key AS lane, terminal_at AS "terminalAt"
      FROM projection_ticket
      WHERE ticket_id = 'ticket-stale-candidate'
    `;

    assert.equal(result.candidateCount, 1);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.equal(yield* ticketOwnedRowCount("ticket-stale-candidate"), 8);
    assert.deepEqual(rows, [{ lane: "backlog", terminalAt: null }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        saveLocksLayer: makeSaveLocksLayer((sql) =>
          movedCandidate
            ? Effect.void
            : Effect.gen(function* () {
                movedCandidate = true;
                yield* sql`
                  UPDATE projection_ticket
                  SET current_lane_key = 'backlog',
                      terminal_at = NULL,
                      updated_at = '2026-06-08T00:00:00.000Z'
                  WHERE ticket_id = 'ticket-stale-candidate'
                `;
              }),
        ),
      }),
    ),
  );
});

it.effect("caps expired ticket deletes per sweep and continues on the next sweep", () =>
  Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;

    yield* registerRetentionBoard;
    for (let index = 0; index < 101; index += 1) {
      yield* seedTicket({
        ticketId: `ticket-batch-${String(index).padStart(3, "0")}`,
        lane: "done",
        terminalAt: "2026-06-06T00:00:00.000Z",
      });
    }

    const first = yield* sweeper.sweep();

    assert.equal(first.candidateCount, 100);
    assert.equal(first.deletedCount, 100);
    assert.equal(first.failedCount, 0);
    assert.equal(yield* ticketOwnedRowCount("ticket-batch-000"), 0);
    assert.equal(yield* ticketOwnedRowCount("ticket-batch-100"), 8);

    const second = yield* sweeper.sweep();

    assert.equal(second.candidateCount, 1);
    assert.equal(second.deletedCount, 1);
    assert.equal(second.failedCount, 0);
    assert.equal(yield* ticketOwnedRowCount("ticket-batch-100"), 0);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("round-robins capped sweeps across boards with expired backlogs", () =>
  Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;
    const firstBoard = "board-retention-round-robin-a";
    const secondBoard = "board-retention-round-robin-b";

    yield* registerRetentionBoardFor(firstBoard);
    yield* registerRetentionBoardFor(secondBoard);
    for (let index = 0; index < 4; index += 1) {
      yield* seedTicket({
        boardId: firstBoard,
        ticketId: `ticket-round-robin-a-${index}`,
        lane: "done",
        terminalAt: "2026-06-06T00:00:00.000Z",
      });
      yield* seedTicket({
        boardId: secondBoard,
        ticketId: `ticket-round-robin-b-${index}`,
        lane: "done",
        terminalAt: "2026-06-06T00:00:00.000Z",
      });
    }

    const first = yield* sweeper.sweep();
    const second = yield* sweeper.sweep();

    assert.equal(first.deletedCount, 2);
    assert.equal(second.deletedCount, 2);
    assert.equal(yield* remainingTicketCountForBoard(firstBoard), 2);
    assert.equal(yield* remainingTicketCountForBoard(secondBoard), 2);
  }).pipe(Effect.provide(makeLayer({ maxDeletesPerSweep: 2 }))),
);

it.effect("continues deleting later expired tickets after one ticket cleanup fails", () => {
  const failedTickets: string[] = [];

  return Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;

    yield* registerRetentionBoard;
    yield* seedTicket({
      ticketId: "ticket-fails",
      lane: "done",
      terminalAt: "2026-06-06T00:00:00.000Z",
    });
    yield* seedTicket({
      ticketId: "ticket-after-failure",
      lane: "done",
      terminalAt: "2026-06-06T00:00:00.000Z",
    });

    const result = yield* sweeper.sweep();

    assert.equal(result.deletedCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(failedTickets, ["ticket-fails"]);
    assert.equal(yield* ticketOwnedRowCount("ticket-fails"), 8);
    assert.equal(yield* ticketOwnedRowCount("ticket-after-failure"), 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        cancelTicketPipelines: (ticketId) =>
          ticketId === "ticket-fails"
            ? Effect.sync(() => {
                failedTickets.push(ticketId as string);
              }).pipe(
                Effect.andThen(
                  Effect.fail(new WorkflowEventStoreError({ message: "cancel failed" })),
                ),
              )
            : Effect.void,
      }),
    ),
  );
});

it.effect("serializes with a concurrent board delete without leaving ticket-owned rows", () =>
  Effect.gen(function* () {
    const sweeper = yield* WorkflowTerminalRetentionSweeper;
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const registry = yield* BoardRegistry;
    const engine = yield* WorkflowEngine;
    const eventStore = yield* WorkflowEventStore;
    const readModel = yield* WorkflowReadModel;
    const sql = yield* SqlClient.SqlClient;

    yield* registerRetentionBoard;
    yield* seedTicket({
      ticketId: "ticket-race",
      lane: "done",
      terminalAt: "2026-06-06T00:00:00.000Z",
    });

    const deleteFiber = yield* Effect.forkChild(
      saveLocks.withSaveLock(
        "board-retention-sweep" as never,
        deleteWorkflowBoardOwnedState(
          {
            boardRegistry: registry,
            engine,
            eventStore,
            readModel,
            versionStore: {
              deleteForBoard: () => Effect.void,
            } satisfies Pick<WorkflowBoardVersionStoreShape, "deleteForBoard">,
            sql,
          },
          "board-retention-sweep" as never,
        ),
      ),
    );
    const sweepFiber = yield* Effect.forkChild(sweeper.sweep());

    yield* Fiber.join(deleteFiber);
    yield* Fiber.join(sweepFiber);

    assert.equal(yield* ticketOwnedRowCount("ticket-race"), 0);
  }).pipe(Effect.timeout("1 second"), Effect.provide(makeLayer())),
);
