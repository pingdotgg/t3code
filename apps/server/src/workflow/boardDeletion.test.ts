import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { BoardRegistry } from "./Services/BoardRegistry.ts";
import type { WorkflowAgentSessionRow } from "./Services/WorkflowAgentSessionStore.ts";
import { WorkflowBoardVersionStore } from "./Services/WorkflowBoardVersionStore.ts";
import { WorkflowEventStore } from "./Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "./Services/WorkflowReadModel.ts";
import {
  deleteWorkflowBoardOwnedState,
  deleteWorkflowBoardTicketOwnedState,
} from "./boardDeletion.ts";
import { BoardRegistryLive } from "./Layers/BoardRegistry.ts";
import { WorkflowBoardVersionStoreLive } from "./Layers/WorkflowBoardVersionStore.ts";
import { WorkflowEventStoreLive } from "./Layers/WorkflowEventStore.ts";
import { WorkflowReadModelLive } from "./Layers/WorkflowReadModel.ts";

const makeAgentSessionRow = (threadId: string): WorkflowAgentSessionRow =>
  ({
    ticketId: "ticket-x" as never,
    laneKey: "done" as never,
    agentKey: "agent-a",
    threadId,
    createdAt: "2026-06-08T00:00:00.000Z",
    lastUsedAt: "2026-06-08T00:00:00.000Z",
  }) satisfies WorkflowAgentSessionRow;

// The cascade only needs `stopSession`, but the dep is typed as a Pick of the
// full provider shape — keep the unused members `die`ing so a mis-wire is loud.
const makeStopOnlyProvider = (
  onStop: (threadId: string) => Effect.Effect<void>,
): Pick<ProviderServiceShape, "stopSession"> => ({
  stopSession: (input) => onStop(input.threadId as string),
});

const deletionLayer = Layer.mergeAll(
  WorkflowEventStoreLive,
  WorkflowReadModelLive,
  WorkflowBoardVersionStoreLive,
).pipe(
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const seedTicketOwnedRows = (ticketId: string) =>
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
        created_at,
        updated_at
      )
      VALUES (
        ${ticketId},
        'board-ticket-cascade',
        ${ticketId},
        'done',
        'done',
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
      VALUES (${`pipeline-${ticketId}`}, ${ticketId}, 'done', ${`token-${ticketId}`}, 'completed', ${now})
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
      VALUES (${`step-${ticketId}`}, ${`pipeline-${ticketId}`}, ${ticketId}, 'cleanup', 'script', 'completed', ${now})
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
      VALUES (${`script-${ticketId}`}, ${`step-${ticketId}`}, ${ticketId}, ${`thread-${ticketId}`}, ${`terminal-${ticketId}`}, 'completed', ${now})
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
      VALUES (${`dispatch-${ticketId}`}, ${ticketId}, ${`step-${ticketId}`}, ${`thread-${ticketId}`}, 'codex', 'gpt-5.5', 'cleanup', ${`/tmp/${ticketId}`}, 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO workflow_setup_run (
        setup_run_id,
        ticket_id,
        worktree_ref,
        status,
        started_at
      )
      VALUES (${`setup-${ticketId}`}, ${ticketId}, ${`worktree-${ticketId}`}, 'completed', ${now})
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
      VALUES (${`message-${ticketId}`}, ${ticketId}, ${`step-${ticketId}`}, 'user', 'cleanup', '[]', ${now})
    `;
    yield* sql`
      INSERT INTO workflow_pr_state (
        ticket_id, pr_number, pr_url, branch, remote_name, repo, pr_state, updated_at
      )
      VALUES (
        ${ticketId}, 1, ${`https://github.com/owner/repo/pull/1`},
        'ft/branch', 'origin', 'owner/repo', 'open', ${now}
      )
    `;
    yield* sql`
      INSERT INTO workflow_pr_observation (
        observation_id, ticket_id, dedup_key, event_name, payload_json, status, created_at
      )
      VALUES (
        ${`obs-${ticketId}`}, ${ticketId}, ${`dedup-${ticketId}`},
        'ci_check', '{}', 'pending', ${now}
      )
    `;
    // sequence is UNIQUE across the table; derive a stable per-ticket integer.
    const outboxSequence = Array.from(ticketId).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    yield* sql`
      INSERT INTO workflow_notification_outbox (
        outbox_id, ticket_id, board_id, sequence, status, created_at
      )
      VALUES (
        ${`outbox-${ticketId}`}, ${ticketId}, 'board-ticket-cascade',
        ${outboxSequence}, 'waiting_on_user', ${now}
      )
    `;
    yield* store.append({
      type: "TicketCreated",
      eventId: `event-${ticketId}` as never,
      ticketId: ticketId as never,
      occurredAt: now as never,
      payload: {
        boardId: "board-ticket-cascade" as never,
        title: ticketId as never,
        laneKey: "done" as never,
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
      UNION ALL SELECT COUNT(*) AS count FROM workflow_pr_state WHERE ticket_id = ${ticketId}
      UNION ALL SELECT COUNT(*) AS count FROM workflow_pr_observation WHERE ticket_id = ${ticketId}
    `;
    return rows.reduce((total, row) => total + row.count, 0);
  });

it.effect("deletes one ticket under the board save lock after cancelling active work", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const sql = yield* SqlClient.SqlClient;
    const record = (call: string) => Ref.update(calls, (current) => [...current, call]);

    yield* deleteWorkflowBoardTicketOwnedState(
      {
        saveLocks: {
          withSaveLock: (boardId, effect) =>
            Effect.gen(function* () {
              yield* record(`lock:${boardId}:enter`);
              const result = yield* effect;
              yield* record(`lock:${boardId}:exit`);
              return result;
            }),
        },
        engine: {
          cancelTicketPipelines: (ticketId) => record(`cancel:${ticketId}`),
        },
        eventStore: {
          deleteForTicket: (ticketId) => record(`events:${ticketId}`),
        },
        readModel: {
          deleteTicketState: (ticketId) => record(`read:${ticketId}`),
        },
        sql,
      },
      "board-ticket-cascade" as never,
      "ticket-cascade" as never,
    );

    assert.deepEqual(yield* Ref.get(calls), [
      "lock:board-ticket-cascade:enter",
      "cancel:ticket-cascade",
      "events:ticket-cascade",
      "read:ticket-cascade",
      "lock:board-ticket-cascade:exit",
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("collects hidden dispatch threads before the cascade and deletes them after", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const sql = yield* SqlClient.SqlClient;
    const record = (call: string) => Ref.update(calls, (current) => [...current, call]);

    yield* deleteWorkflowBoardTicketOwnedState(
      {
        saveLocks: {
          withSaveLock: (_boardId, effect) => effect,
        },
        engine: {
          cancelTicketPipelines: () => Effect.void,
        },
        eventStore: {
          deleteForTicket: () => record("cascade:events"),
        },
        readModel: {
          deleteTicketState: () => record("cascade:read"),
        },
        sql,
        threadJanitor: {
          collectTicketThreads: (ticketId) =>
            record(`collect:${ticketId}`).pipe(
              Effect.as(["thread-a", "thread-b"] as ReadonlyArray<string>),
            ),
          deleteThreads: (threadIds) => record(`delete:${threadIds.join("+")}`),
        },
      },
      "board-ticket-cascade" as never,
      "ticket-threads" as never,
    );

    assert.deepEqual(yield* Ref.get(calls), [
      "collect:ticket-threads",
      "cascade:events",
      "cascade:read",
      "delete:thread-a+thread-b",
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rolls back events and read-model rows when the ticket cascade fails", () =>
  Effect.gen(function* () {
    const eventStore = yield* WorkflowEventStore;
    const readModel = yield* WorkflowReadModel;
    const sql = yield* SqlClient.SqlClient;
    const ticketId = "ticket-cascade-rollback";

    yield* seedTicketOwnedRows(ticketId);
    yield* sql`
      CREATE TRIGGER fail_ticket_cascade_step_delete
      BEFORE DELETE ON projection_step_run
      WHEN OLD.ticket_id = 'ticket-cascade-rollback'
      BEGIN
        SELECT RAISE(FAIL, 'simulated ticket cascade failure');
      END
    `;

    const result = yield* Effect.exit(
      deleteWorkflowBoardTicketOwnedState(
        {
          saveLocks: {
            withSaveLock: (_boardId, effect) => effect,
          },
          engine: {
            cancelTicketPipelines: () => Effect.void,
          },
          eventStore,
          readModel,
          sql,
        },
        "board-ticket-cascade" as never,
        ticketId as never,
      ),
    );

    assert.equal(result._tag, "Failure");
    assert.equal(yield* ticketOwnedRowCount(ticketId), 10);
  }).pipe(Effect.provide(deletionLayer)),
);

it.effect(
  "board deletion cascades into workflow_pr_state and workflow_pr_observation, and workflow_notification_outbox",
  () =>
    Effect.gen(function* () {
      const eventStore = yield* WorkflowEventStore;
      const readModel = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const ticketId = "ticket-pr-cascade";

      yield* seedTicketOwnedRows(ticketId);

      yield* deleteWorkflowBoardTicketOwnedState(
        {
          saveLocks: {
            withSaveLock: (_boardId, effect) => effect,
          },
          engine: {
            cancelTicketPipelines: () => Effect.void,
          },
          eventStore,
          readModel,
          sql,
        },
        "board-ticket-cascade" as never,
        ticketId as never,
      );

      const prStateCount = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM workflow_pr_state WHERE ticket_id = ${ticketId}
    `;
      const prObsCount = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM workflow_pr_observation WHERE ticket_id = ${ticketId}
    `;
      const outboxCount = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM workflow_notification_outbox WHERE ticket_id = ${ticketId}
    `;
      assert.equal(prStateCount[0]?.count, 0);
      assert.equal(prObsCount[0]?.count, 0);
      assert.equal(outboxCount[0]?.count, 0);
    }).pipe(Effect.provide(deletionLayer)),
);

it.effect(
  "board deletion collects threads first, runs DB cascade in a transaction, then cleans up",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const realSql = yield* SqlClient.SqlClient;
      const record = (call: string) => Ref.update(calls, (current) => [...current, call]);

      yield* deleteWorkflowBoardOwnedState(
        {
          boardRegistry: { unregister: (boardId) => record(`unregister:${boardId}`) },
          engine: { cancelBoardPipelines: (boardId) => record(`cancel:${boardId}`) },
          eventStore: { deleteForBoard: () => record("db:events") },
          readModel: {
            deleteBoardTicketState: () => record("db:ticketState"),
            deleteBoard: () => record("db:board"),
          },
          versionStore: { deleteForBoard: () => record("db:versions") },
          webhook: { deleteForBoard: () => record("db:webhook") },
          // Wrap the inner cascade so the test can assert all DB deletes ran
          // inside one transaction boundary.
          sql: {
            withTransaction: (effect) =>
              record("tx:begin").pipe(
                Effect.andThen(effect),
                Effect.tap(() => record("tx:commit")),
              ) as never,
          },
          threadJanitor: {
            collectBoardThreads: (boardId) =>
              record(`collect:${boardId}`).pipe(
                Effect.as(["thread-a", "thread-b"] as ReadonlyArray<string>),
              ),
            deleteThreads: (threadIds) => record(`deleteThreads:${threadIds.join("+")}`),
          },
        },
        "board-cascade" as never,
      );

      assert.deepEqual(yield* Ref.get(calls), [
        "collect:board-cascade",
        "cancel:board-cascade",
        "tx:begin",
        "db:webhook",
        "db:versions",
        "db:events",
        "db:ticketState",
        "db:board",
        "tx:commit",
        "unregister:board-cascade",
        "deleteThreads:thread-a+thread-b",
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "board deletion lists stored agent sessions before the cascade, deletes them, and stops their threads",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const realSql = yield* SqlClient.SqlClient;
      const record = (call: string) => Ref.update(calls, (current) => [...current, call]);

      yield* deleteWorkflowBoardOwnedState(
        {
          boardRegistry: { unregister: (boardId) => record(`unregister:${boardId}`) },
          engine: { cancelBoardPipelines: (boardId) => record(`cancel:${boardId}`) },
          eventStore: { deleteForBoard: () => record("db:events") },
          readModel: {
            deleteBoardTicketState: () => record("db:ticketState"),
            deleteBoard: () => record("db:board"),
          },
          versionStore: { deleteForBoard: () => record("db:versions") },
          sql: {
            withTransaction: (effect) =>
              record("tx:begin").pipe(
                Effect.andThen(effect),
                Effect.tap(() => record("tx:commit")),
              ) as never,
          },
          // The store join needs projection_ticket, so the rows must be listed
          // before the cascade and deleted inside the tx (before deleteBoardTicketState
          // clears projection_ticket); stopSession runs after the commit.
          agentSessions: {
            listByBoard: (boardId) =>
              record(`agent:list:${boardId}`).pipe(
                Effect.as([
                  makeAgentSessionRow("agent-thread-a"),
                  makeAgentSessionRow("agent-thread-b"),
                ]),
              ),
            deleteByBoard: (boardId) => record(`agent:delete:${boardId}`),
          },
          provider: makeStopOnlyProvider((threadId) => record(`agent:stop:${threadId}`)),
        },
        "board-agent-cascade" as never,
      );

      assert.deepEqual(yield* Ref.get(calls), [
        "agent:list:board-agent-cascade",
        "cancel:board-agent-cascade",
        "tx:begin",
        "db:versions",
        "agent:delete:board-agent-cascade",
        "db:events",
        "db:ticketState",
        "db:board",
        "tx:commit",
        "unregister:board-agent-cascade",
        "agent:stop:agent-thread-a",
        "agent:stop:agent-thread-b",
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rolls back the board DB cascade when a delete fails mid-transaction", () =>
  Effect.gen(function* () {
    const eventStore = yield* WorkflowEventStore;
    const readModel = yield* WorkflowReadModel;
    const versionStore = yield* WorkflowBoardVersionStore;
    const registry = yield* BoardRegistry;
    const sql = yield* SqlClient.SqlClient;
    const ticketId = "ticket-board-rollback";

    yield* seedTicketOwnedRows(ticketId);
    // Fail mid-cascade (the projection_ticket delete is part of
    // deleteBoardTicketState) so the transaction must roll back the already-run
    // event-store and version deletes.
    yield* sql`
      CREATE TRIGGER fail_board_cascade_ticket_delete
      BEFORE DELETE ON projection_ticket
      WHEN OLD.ticket_id = 'ticket-board-rollback'
      BEGIN
        SELECT RAISE(FAIL, 'simulated board cascade failure');
      END
    `;

    const result = yield* Effect.exit(
      deleteWorkflowBoardOwnedState(
        {
          boardRegistry: registry,
          engine: { cancelBoardPipelines: () => Effect.void },
          eventStore,
          readModel,
          versionStore,
          sql,
        },
        "board-ticket-cascade" as never,
      ),
    );

    assert.equal(result._tag, "Failure");
    // Every owned row survives: the failing delete rolled the whole tx back.
    assert.equal(yield* ticketOwnedRowCount(ticketId), 10);
  }).pipe(Effect.provide(deletionLayer)),
);
