import { assert, it } from "@effect/vitest";
import type { BoardId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStore, type PersistedWorkflowEvent } from "../Services/WorkflowEventStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const layer = it.layer(
  WorkflowEventCommitterLive.pipe(
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const registerBoard = (boardId: string) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;
    yield* registry.register(boardId as never, {
      name: boardId,
      lanes: [{ key: "impl", name: "Impl", entry: "manual" }],
    });
    yield* read.registerBoard({
      boardId: boardId as never,
      projectId: "project-committer" as never,
      name: boardId,
      workflowFilePath: `.t3/boards/${boardId}.json`,
      workflowVersionHash: `hash-${boardId}`,
      maxConcurrentTickets: 3,
    });
  });

const insertProjectedTicket = (input: {
  readonly ticketId: string;
  readonly boardId: string;
  readonly title: string;
  readonly lane?: string;
  readonly status?: string;
}) =>
  Effect.gen(function* () {
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
        ${input.ticketId},
        ${input.boardId},
        ${input.title},
        ${input.lane ?? "impl"},
        ${input.status ?? "running"},
        ${now},
        ${now}
      )
    `;
  });

const workflowEventCount = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM workflow_events
      WHERE ticket_id = ${ticketId}
    `;
    return rows[0]?.count ?? 0;
  });

interface OutboxRow {
  readonly outboxId: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly sequence: number;
  readonly status: string;
  readonly attentionKind: string | null;
  readonly attentionReason: string | null;
  readonly deliveryState: string;
  readonly attemptCount: number;
}

const outboxRows = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<OutboxRow>`
      SELECT
        outbox_id AS "outboxId",
        ticket_id AS "ticketId",
        board_id AS "boardId",
        sequence,
        status,
        attention_kind AS "attentionKind",
        attention_reason AS "attentionReason",
        delivery_state AS "deliveryState",
        attempt_count AS "attemptCount"
      FROM workflow_notification_outbox
      WHERE ticket_id = ${ticketId}
      ORDER BY sequence ASC
    `;
  });

const outboxCount = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM workflow_notification_outbox
      WHERE ticket_id = ${ticketId}
    `;
    return rows[0]?.count ?? 0;
  });

const commitManyLayerWithSaveLockInterposition = (
  expectedBoardId: BoardId,
  beforeLockedEffect: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError>,
) => {
  const saveLocksLayer = Layer.effect(
    WorkflowBoardSaveLocks,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        withSaveLock: (lockBoardId, effect) =>
          Effect.gen(function* () {
            if (lockBoardId !== expectedBoardId) {
              return yield* Effect.die(`unexpected board lock ${lockBoardId as string}`);
            }
            yield* beforeLockedEffect(sql).pipe(Effect.orDie);
            return yield* effect;
          }),
      } satisfies WorkflowBoardSaveLocks["Service"];
    }),
  );

  return WorkflowEventCommitterLive.pipe(
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(saveLocksLayer),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
};

it.effect(
  "WorkflowEventCommitter.commitMany acquires the board save lock before its transaction without re-entering it",
  () =>
    Effect.gen(function* () {
      const boardId = "b-commit-many-delete-lock-order" as BoardId;
      const persistedEvents: PersistedWorkflowEvent[] = [];
      const projectedEvents: PersistedWorkflowEvent[] = [];
      let inTransaction = false;
      let boardLockHeld = false;
      let saveLockAcquisitions = 0;

      const unsupportedEffect = () => Effect.die("unsupported fake committer dependency") as never;
      const unsupportedStream = () => Stream.die("unsupported fake committer dependency") as never;
      const fakeSql = Object.assign(
        // Tagged queries (status diff selects + outbox insert) return empty rows;
        // this batch never crosses into a needs-you status so no insert is asserted.
        (() => Effect.succeed([])) as unknown as SqlClient.SqlClient,
        {
          withTransaction: <R, E, A>(effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              if (inTransaction) {
                return yield* Effect.die("commitMany opened a nested transaction");
              }
              inTransaction = true;
              return yield* effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    inTransaction = false;
                  }),
                ),
              );
            }),
        } satisfies Partial<SqlClient.SqlClient>,
      ) as SqlClient.SqlClient;
      const fakeSaveLocks = Layer.succeed(WorkflowBoardSaveLocks, {
        withSaveLock: (lockBoardId, effect) =>
          Effect.gen(function* () {
            if (lockBoardId !== boardId) {
              return yield* Effect.die(`unexpected board lock ${lockBoardId as string}`);
            }
            if (inTransaction) {
              return yield* Effect.die("commitMany acquired the save lock inside a transaction");
            }
            if (boardLockHeld) {
              return yield* Effect.die("commitMany re-entered the non-reentrant save lock");
            }
            saveLockAcquisitions += 1;
            boardLockHeld = true;
            return yield* effect.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  boardLockHeld = false;
                }),
              ),
            );
          }),
      } satisfies WorkflowBoardSaveLocks["Service"]);
      const fakeStore = Layer.succeed(WorkflowEventStore, {
        append: (event) =>
          Effect.sync(() => {
            const persisted = {
              ...event,
              streamVersion: persistedEvents.length,
              sequence: persistedEvents.length + 1,
            } as PersistedWorkflowEvent;
            persistedEvents.push(persisted);
            return persisted;
          }),
        readByTicket: unsupportedStream,
        readFromSequence: unsupportedStream,
        readAll: unsupportedStream,
        deleteForBoard: unsupportedEffect,
        deleteForTicket: unsupportedEffect,
      } satisfies WorkflowEventStore["Service"]);
      const fakeProjectionPipeline = Layer.succeed(WorkflowProjectionPipeline, {
        projectEvent: (event) =>
          Effect.sync(() => {
            projectedEvents.push(event as PersistedWorkflowEvent);
          }),
      } satisfies WorkflowProjectionPipeline["Service"]);
      const fakeReadModel = Layer.succeed(WorkflowReadModel, {
        registerBoard: unsupportedEffect,
        getBoard: unsupportedEffect,
        deleteBoard: unsupportedEffect,
        deleteBoardTicketState: unsupportedEffect,
        deleteTicketState: unsupportedEffect,
        listBoardsForProject: unsupportedEffect,
        listTickets: unsupportedEffect,
        countAdmittedInLane: unsupportedEffect,
        oldestQueuedForLane: unsupportedEffect,
        getTicketDetail: () => Effect.succeed(null),
        listTicketMessages: unsupportedEffect,
        listStepRunsForPipeline: unsupportedEffect,
        countLanePipelineRuns: unsupportedEffect,
        listTicketDiscussion: unsupportedEffect,
        listReleasableDependents: unsupportedEffect,
        getBoardDigest: unsupportedEffect,
        getBoardMetrics: unsupportedEffect,
        listNeedsAttentionTickets: () => Effect.succeed([]),
        listDependentTicketIds: () => Effect.succeed([]),
        listTicketRouteDecisions: unsupportedEffect,
        getTicketPrState: unsupportedEffect,
        recordBoardProposal: unsupportedEffect,
        listBoardProposals: () => Effect.succeed([]),
        getBoardProposal: () => Effect.succeed(null),
        listLiveOccupiedLanes: () => Effect.succeed([]),
        resolveBoardProposalStatus: () => Effect.succeed(1),
        listWorkSourceMappingsForBoard: () => Effect.succeed([]),
      } satisfies WorkflowReadModel["Service"]);
      const fakeRegistry = Layer.succeed(BoardRegistry, {
        register: unsupportedEffect,
        unregister: unsupportedEffect,
        getDefinition: (requestedBoardId) =>
          Effect.succeed(
            requestedBoardId === boardId
              ? ({
                  name: "Fake",
                  lanes: [{ key: "backlog", name: "Backlog", entry: "manual" }],
                } as never)
              : null,
          ),
        listDefinitions: unsupportedEffect,
        getLane: unsupportedEffect,
      } satisfies BoardRegistry["Service"]);
      const fakeIds = Layer.succeed(WorkflowIds, {
        ticketId: unsupportedEffect,
        pipelineRunId: unsupportedEffect,
        scriptRunId: unsupportedEffect,
        stepRunId: unsupportedEffect,
        messageId: unsupportedEffect,
        eventId: () => Effect.succeed("evt-fake" as never),
        token: unsupportedEffect,
        mappingId: unsupportedEffect,
      } satisfies WorkflowIds["Service"]);

      yield* Effect.gen(function* () {
        const committer = yield* WorkflowEventCommitter;

        yield* committer.commitMany([
          {
            type: "TicketCreated",
            eventId: "e-commit-many-delete-lock-order-1" as never,
            ticketId: "t-commit-many-delete-lock-order" as never,
            occurredAt: "2026-06-07T00:00:00.000Z" as never,
            payload: {
              boardId,
              title: "Lock order" as never,
              laneKey: "backlog" as never,
            },
          },
          {
            type: "TicketMovedToLane",
            eventId: "e-commit-many-delete-lock-order-2" as never,
            ticketId: "t-commit-many-delete-lock-order" as never,
            occurredAt: "2026-06-07T00:00:01.000Z" as never,
            payload: {
              toLane: "backlog" as never,
              laneEntryToken: "tok-lock-order" as never,
              reason: "routed",
            },
          },
        ]);

        assert.equal(saveLockAcquisitions, 1);
        assert.deepEqual(
          persistedEvents.map((event) => event.type),
          ["TicketCreated", "TicketMovedToLane"],
        );
        assert.deepEqual(
          projectedEvents.map((event) => event.type),
          ["TicketCreated", "TicketMovedToLane"],
        );
      }).pipe(
        Effect.provide(
          WorkflowEventCommitterLive.pipe(
            Layer.provideMerge(fakeRegistry),
            Layer.provideMerge(PredicateEvaluatorLive),
            Layer.provideMerge(fakeSaveLocks),
            Layer.provideMerge(fakeStore),
            Layer.provideMerge(fakeProjectionPipeline),
            Layer.provideMerge(fakeReadModel),
            Layer.provideMerge(fakeIds),
            Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, fakeSql)),
          ),
        ),
      );
    }),
);

it.effect(
  "commitMany skips stale events when an existing ticket was deleted under the save lock",
  () =>
    Effect.gen(function* () {
      const boardId = "b-commit-many-retention-delete" as BoardId;
      const ticketId = "t-commit-many-retention-delete";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({
        ticketId,
        boardId,
        title: "Retention deleted",
      });

      yield* committer.commitMany([
        {
          type: "TicketBlocked",
          eventId: "e-commit-many-retention-delete" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: { reason: "stale" },
        },
      ]);

      assert.equal(yield* workflowEventCount(ticketId), 0);
    }).pipe(
      Effect.provide(
        commitManyLayerWithSaveLockInterposition(
          "b-commit-many-retention-delete" as BoardId,
          (sql) =>
            sql`
            DELETE FROM projection_ticket
            WHERE ticket_id = ${"t-commit-many-retention-delete"}
          `.pipe(Effect.asVoid),
        ),
      ),
    ),
);

it.effect(
  "commitMany skips stale events when an existing ticket moved to another board under the save lock",
  () =>
    Effect.gen(function* () {
      const originalBoardId = "b-commit-many-move-original" as BoardId;
      const movedBoardId = "b-commit-many-move-target" as BoardId;
      const ticketId = "t-commit-many-move";
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;
      yield* registerBoard(originalBoardId);
      yield* registerBoard(movedBoardId);
      yield* insertProjectedTicket({
        ticketId,
        boardId: originalBoardId,
        title: "Moved",
      });

      yield* committer.commitMany([
        {
          type: "TicketBlocked",
          eventId: "e-commit-many-move" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: { reason: "wrong-board" },
        },
      ]);

      const tickets = yield* sql<{ readonly boardId: string; readonly status: string }>`
      SELECT board_id AS "boardId", status
      FROM projection_ticket
      WHERE ticket_id = ${ticketId}
    `;
      assert.equal(yield* workflowEventCount(ticketId), 0);
      assert.deepEqual(tickets, [{ boardId: movedBoardId, status: "running" }]);
    }).pipe(
      Effect.provide(
        commitManyLayerWithSaveLockInterposition("b-commit-many-move-original" as BoardId, (sql) =>
          sql`
            UPDATE projection_ticket
            SET board_id = ${"b-commit-many-move-target"}
            WHERE ticket_id = ${"t-commit-many-move"}
          `.pipe(Effect.asVoid),
        ),
      ),
    ),
);

layer("WorkflowEventCommitter", (it) => {
  it.effect("appends and projects in one call", () =>
    Effect.gen(function* () {
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;
      yield* registerBoard("b-1");

      yield* committer.commit({
        type: "TicketCreated",
        eventId: "e1" as never,
        ticketId: "t-1" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: { boardId: "b-1" as never, title: "X" as never, laneKey: "backlog" as never },
      });

      const rows = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_ticket WHERE ticket_id = 't-1'
      `;
      assert.equal(rows[0]?.title, "X");
    }),
  );

  it.effect("commitMany appends and projects all events in one transaction", () =>
    Effect.gen(function* () {
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;
      yield* registerBoard("b-1");

      yield* committer.commitMany([
        {
          type: "TicketCreated",
          eventId: "e-many-1" as never,
          ticketId: "t-many" as never,
          occurredAt: "2026-06-07T00:00:00.000Z" as never,
          payload: { boardId: "b-1" as never, title: "Many" as never, laneKey: "backlog" as never },
        },
        {
          type: "TicketMovedToLane",
          eventId: "e-many-2" as never,
          ticketId: "t-many" as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: {
            toLane: "impl" as never,
            laneEntryToken: "tok-many" as never,
            reason: "routed",
          },
        },
      ]);

      const events = yield* sql<{ readonly eventType: string; readonly streamVersion: number }>`
        SELECT event_type AS "eventType", stream_version AS "streamVersion"
        FROM workflow_events
        WHERE ticket_id = 't-many'
        ORDER BY stream_version ASC
      `;
      const tickets = yield* sql<{ readonly lane: string; readonly token: string | null }>`
        SELECT current_lane_key AS lane, current_lane_entry_token AS token
        FROM projection_ticket
        WHERE ticket_id = 't-many'
      `;
      assert.deepEqual(events, [
        { eventType: "TicketCreated", streamVersion: 0 },
        { eventType: "TicketMovedToLane", streamVersion: 1 },
      ]);
      assert.deepEqual(tickets, [{ lane: "impl", token: "tok-many" }]);
    }),
  );

  it.effect("commitMany rolls back earlier appends and projections when a later append fails", () =>
    Effect.gen(function* () {
      const committer = yield* WorkflowEventCommitter;
      const sql = yield* SqlClient.SqlClient;
      yield* registerBoard("b-rollback");

      const exit = yield* Effect.exit(
        committer.commitMany([
          {
            type: "TicketCreated",
            eventId: "e-rollback-shared" as never,
            ticketId: "t-rollback-a" as never,
            occurredAt: "2026-06-07T00:00:00.000Z" as never,
            payload: {
              boardId: "b-rollback" as never,
              title: "Rollback A" as never,
              laneKey: "backlog" as never,
            },
          },
          {
            type: "TicketCreated",
            eventId: "e-rollback-shared" as never,
            ticketId: "t-rollback-b" as never,
            occurredAt: "2026-06-07T00:00:01.000Z" as never,
            payload: {
              boardId: "b-rollback" as never,
              title: "Rollback B" as never,
              laneKey: "backlog" as never,
            },
          },
        ]),
      );
      assert.isTrue(Exit.isFailure(exit));

      const eventRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id IN ('t-rollback-a', 't-rollback-b')
      `;
      const projectionRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_ticket
        WHERE ticket_id IN ('t-rollback-a', 't-rollback-b')
      `;
      assert.equal(eventRows[0]?.count, 0);
      assert.equal(projectionRows[0]?.count, 0);
    }),
  );

  it.effect(
    "commitMany appends and projects an event for an existing ticket that still matches the board",
    () =>
      Effect.gen(function* () {
        const boardId = "b-commit-many-existing" as BoardId;
        const ticketId = "t-commit-many-existing";
        const committer = yield* WorkflowEventCommitter;
        const sql = yield* SqlClient.SqlClient;
        yield* registerBoard(boardId);
        yield* insertProjectedTicket({
          ticketId,
          boardId,
          title: "Existing",
        });

        yield* committer.commitMany([
          {
            type: "TicketBlocked",
            eventId: "e-commit-many-existing" as never,
            ticketId: ticketId as never,
            occurredAt: "2026-06-07T00:00:01.000Z" as never,
            payload: { reason: "normal" },
          },
        ]);

        const tickets = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM projection_ticket
        WHERE ticket_id = ${ticketId}
      `;
        assert.equal(yield* workflowEventCount(ticketId), 1);
        assert.deepEqual(tickets, [{ status: "blocked" }]);
      }),
  );

  it.effect("does not append a step event when board deletion wins the save lock", () =>
    Effect.gen(function* () {
      const boardId = "b-committer-delete-race" as never;
      const ticketId = "t-committer-delete-race" as never;
      const now = "2026-06-07T00:00:00.000Z";
      const committer = yield* WorkflowEventCommitter;
      const eventStore = yield* WorkflowEventStore;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const saveLocks = yield* WorkflowBoardSaveLocks;
      const sql = yield* SqlClient.SqlClient;
      const deleteReady = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();

      yield* registerBoard(boardId);
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
        VALUES (${ticketId}, ${boardId}, 'Delete race', 'impl', 'running', ${now}, ${now})
      `;

      const deleteFiber = yield* saveLocks
        .withSaveLock(
          boardId,
          Effect.gen(function* () {
            yield* eventStore.deleteForBoard(boardId);
            yield* read.deleteBoardTicketState(boardId);
            yield* registry.unregister(boardId);
            yield* read.deleteBoard(boardId);
            yield* Deferred.succeed(deleteReady, undefined);
            yield* Deferred.await(releaseDelete);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(deleteReady).pipe(Effect.timeout("1 second"));
      const commitFiber = yield* committer
        .commit({
          type: "StepCompleted",
          eventId: "evt-delete-race-step-completed" as never,
          ticketId,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: { stepRunId: "step-delete-race" as never },
        })
        .pipe(Effect.exit, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseDelete, undefined);
      yield* Fiber.join(deleteFiber).pipe(Effect.timeout("1 second"));
      yield* Fiber.join(commitFiber).pipe(Effect.timeout("1 second"));

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id = ${ticketId}
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );

  it.effect("writes exactly one outbox row when an event flips a ticket into waiting_on_user", () =>
    Effect.gen(function* () {
      const boardId = "b-outbox-waiting";
      const ticketId = "t-outbox-waiting";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Waiting", status: "running" });

      const persisted = yield* committer.commit({
        type: "StepAwaitingUser",
        eventId: "e-outbox-waiting" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          stepRunId: "step-outbox-waiting" as never,
          waitingReason: "Need input",
          providerResponseKind: "user-input",
        },
      });

      const rows = yield* outboxRows(ticketId);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.ticketId, ticketId);
      assert.equal(row.boardId, boardId);
      assert.equal(row.status, "waiting_on_user");
      assert.equal(row.attentionKind, "waiting_for_input");
      assert.equal(row.attentionReason, "Need input");
      assert.equal(row.deliveryState, "pending");
      assert.equal(row.attemptCount, 0);
      // sequence matches the persisted event's sequence (the commit returns it)
      const eventRows = yield* (yield* SqlClient.SqlClient)<{ readonly sequence: number }>`
          SELECT sequence FROM workflow_events WHERE ticket_id = ${ticketId}
        `;
      assert.equal(row.sequence, eventRows[0]?.sequence);
      assert.isNotNull(persisted);
    }),
  );

  it.effect("writes a blocked outbox row when a ticket is blocked", () =>
    Effect.gen(function* () {
      const boardId = "b-outbox-blocked";
      const ticketId = "t-outbox-blocked";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Blocked", status: "running" });

      yield* committer.commit({
        type: "TicketBlocked",
        eventId: "e-outbox-blocked" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { reason: "dependency missing" },
      });

      const rows = yield* outboxRows(ticketId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "blocked");
      assert.equal(rows[0]?.attentionKind, "blocked");
      assert.equal(rows[0]?.attentionReason, "dependency missing");
    }),
  );

  it.effect("writes no outbox row when an event does not cross into a needs-you state", () =>
    Effect.gen(function* () {
      const boardId = "b-outbox-no-cross";
      const ticketId = "t-outbox-no-cross";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Plain", status: "running" });

      // A plain lane move keeps the ticket out of any needs-you status.
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-outbox-no-cross" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "tok-no-cross" as never,
          reason: "routed",
        },
      });

      assert.equal(yield* outboxCount(ticketId), 0);
    }),
  );

  it.effect(
    "does not write a second outbox row when the ticket stays in the same needs-you status",
    () =>
      Effect.gen(function* () {
        const boardId = "b-outbox-stay";
        const ticketId = "t-outbox-stay";
        const committer = yield* WorkflowEventCommitter;
        yield* registerBoard(boardId);
        yield* insertProjectedTicket({ ticketId, boardId, title: "Stay", status: "running" });

        // First transition into waiting_on_user → one row.
        yield* committer.commit({
          type: "StepAwaitingUser",
          eventId: "e-outbox-stay-1" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: {
            stepRunId: "step-outbox-stay" as never,
            waitingReason: "First",
            providerResponseKind: "user-input",
          },
        });
        assert.equal(yield* outboxCount(ticketId), 1);

        // A second StepAwaitingUser while already waiting_on_user → still one row
        // (newStatus is needs-you but newStatus === prevStatus, so no new transition).
        yield* committer.commit({
          type: "StepAwaitingUser",
          eventId: "e-outbox-stay-2" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:02.000Z" as never,
          payload: {
            stepRunId: "step-outbox-stay" as never,
            waitingReason: "Second",
            providerResponseKind: "user-input",
          },
        });
        assert.equal(yield* outboxCount(ticketId), 1);
      }),
  );

  it.effect(
    "supersedes the prior pending row when a ticket rapidly transitions to a new needs-you state",
    () =>
      Effect.gen(function* () {
        const boardId = "b-outbox-supersede";
        const ticketId = "t-outbox-supersede";
        const committer = yield* WorkflowEventCommitter;
        yield* registerBoard(boardId);
        yield* insertProjectedTicket({ ticketId, boardId, title: "Supersede", status: "running" });

        // 1) waiting_on_user → outbox row A (pending)
        yield* committer.commit({
          type: "StepAwaitingUser",
          eventId: "e-outbox-supersede-1" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: {
            stepRunId: "step-outbox-supersede" as never,
            waitingReason: "approve deploy?",
            providerResponseKind: "request",
          },
        });
        // 2) blocked → outbox row B (pending); row A must be superseded
        yield* committer.commit({
          type: "TicketBlocked",
          eventId: "e-outbox-supersede-2" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:02.000Z" as never,
          payload: { reason: "merge conflict" },
        });

        const rows = yield* outboxRows(ticketId);
        assert.equal(rows.length, 2);
        const pending = rows.filter((row) => row.deliveryState === "pending");
        const superseded = rows.filter((row) => row.deliveryState === "superseded");
        // Exactly one pending row remains — the latest (blocked) transition.
        assert.equal(pending.length, 1);
        assert.equal(pending[0]?.status, "blocked");
        assert.equal(pending[0]?.attentionKind, "blocked");
        assert.equal(pending[0]?.attentionReason, "merge conflict");
        // The earlier waiting row is superseded (never delivered).
        assert.equal(superseded.length, 1);
        assert.equal(superseded[0]?.status, "waiting_on_user");
        // The pending row is the highest sequence.
        assert.isAbove(pending[0]!.sequence, superseded[0]!.sequence);
      }),
  );

  it.effect(
    "the supersede guard does not strand the current row on idempotent re-projection of the same sequence",
    () =>
      Effect.gen(function* () {
        // The committer's event store enforces UNIQUE(event_id), so a duplicate
        // commit fails at append before reaching the outbox path. This test instead
        // exercises the load-bearing `sequence != persisted.sequence` guard SQL
        // directly: a row already pending at sequence S must survive a re-run of the
        // supersede+insert pair for that SAME sequence S, while a genuinely older
        // pending row (different sequence) gets superseded.
        const ticketId = "t-outbox-idempotent";
        const boardId = "b-outbox-idempotent";
        const sql = yield* SqlClient.SqlClient;

        const insertPending = (outboxId: string, sequence: number) =>
          sql`
            INSERT OR IGNORE INTO workflow_notification_outbox (
              outbox_id, ticket_id, board_id, sequence, status,
              attention_kind, attention_reason, delivery_state, attempt_count, created_at
            ) VALUES (
              ${outboxId}, ${ticketId}, ${boardId}, ${sequence}, 'waiting_on_user',
              'waiting_for_input', 'r', 'pending', 0, '2026-06-07T00:00:00.000Z'
            )
          `;
        const supersedeOthers = (sequence: number) =>
          sql`
            UPDATE workflow_notification_outbox
            SET delivery_state = 'superseded'
            WHERE ticket_id = ${ticketId}
              AND delivery_state = 'pending'
              AND sequence != ${sequence}
          `;

        // Older pending row at sequence 1, current pending row at sequence 2.
        yield* insertPending("ob-old", 1);
        yield* insertPending("ob-current", 2);

        // Re-projection of the SAME event (sequence 2): supersede others, then
        // re-insert (ignored as a duplicate). The current row must stay pending.
        yield* supersedeOthers(2);
        yield* insertPending("ob-current", 2);

        const rows = yield* outboxRows(ticketId);
        assert.equal(rows.length, 2);
        const current = rows.find((row) => row.sequence === 2);
        const older = rows.find((row) => row.sequence === 1);
        // The != guard protected the current sequence's own row.
        assert.equal(current?.deliveryState, "pending");
        // Genuinely older pending row was superseded.
        assert.equal(older?.deliveryState, "superseded");
      }),
  );
});

it.effect(
  "rolls back both the event and the outbox row when projection fails inside the commit transaction",
  () =>
    Effect.gen(function* () {
      const boardId = "b-outbox-atomic" as BoardId;
      const ticketId = "t-outbox-atomic";

      const committer = yield* WorkflowEventCommitter;

      // Match the other integration tests' setup: register the board (registry +
      // projection_board) then seed a running projection_ticket row.
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Atomic", status: "running" });

      const exit = yield* Effect.exit(
        committer.commit({
          type: "TicketBlocked",
          eventId: "e-outbox-atomic" as never,
          ticketId: ticketId as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: { reason: "boom" },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));

      // The failing projection must roll back the appended event AND prevent any
      // outbox row from being written (single-commit path is transactional).
      assert.equal(yield* workflowEventCount(ticketId), 0);
      assert.equal(yield* outboxCount(ticketId), 0);
    }).pipe(
      Effect.provide(
        WorkflowEventCommitterLive.pipe(
          Layer.provideMerge(BoardRegistryLive),
          Layer.provideMerge(PredicateEvaluatorLive),
          Layer.provideMerge(WorkflowBoardSaveLocksLive),
          // Replace the real projection pipeline with one that always fails so the
          // surrounding transaction must roll back the appended event.
          Layer.provideMerge(
            Layer.succeed(WorkflowProjectionPipeline, {
              projectEvent: () => Effect.fail("projection blew up") as never,
            } satisfies WorkflowProjectionPipeline["Service"]),
          ),
          Layer.provideMerge(DeterministicWorkflowIds),
          Layer.provideMerge(WorkflowFoundationLive),
          Layer.provideMerge(MigrationsLive),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
);
