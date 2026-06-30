import { assert, it } from "@effect/vitest";
import type { BoardId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { PredicateEvaluationError, PredicateEvaluator } from "../Services/PredicateEvaluator.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
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

// A PredicateEvaluator that always errors — used to prove the committer isolates
// predicate-eval failures (skips the rule, never fails the commit). The board
// lint shares the same static JSONLogic inspector as the live evaluator, so any
// rule that registers cannot statically fail at eval time; a failing-evaluator
// stub deterministically reproduces a runtime eval error.
const failingEvaluatorLayer = WorkflowEventCommitterLive.pipe(
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(
    Layer.succeed(PredicateEvaluator, {
      evaluate: () => Effect.fail(new PredicateEvaluationError({ message: "forced eval failure" })),
    } satisfies PredicateEvaluator["Service"]),
  ),
  Layer.provideMerge(WorkflowBoardSaveLocksLive),
  Layer.provideMerge(DeterministicWorkflowIds),
  Layer.provideMerge(WorkflowFoundationLive),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

// A board with multiple lanes, one of which is terminal, so terminal/`done`
// rules and lane_entered `when` predicates can be exercised.
const registerBoard = (boardId: string, outbound: ReadonlyArray<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;
    yield* registry.register(boardId as never, {
      name: boardId,
      outbound: outbound as never,
      lanes: [
        { key: "impl", name: "Impl", entry: "manual" },
        { key: "in-progress", name: "In Progress", entry: "manual" },
        { key: "needs-attention", name: "Needs Attention", entry: "manual" },
        { key: "shipped", name: "Shipped", entry: "manual", terminal: true },
      ] as never,
    });
    yield* read.registerBoard({
      boardId: boardId as never,
      projectId: "project-outbound" as never,
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
        ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
      ) VALUES (
        ${input.ticketId}, ${input.boardId}, ${input.title},
        ${input.lane ?? "impl"}, ${input.status ?? "running"}, ${now}, ${now}
      )
    `;
  });

interface DeliveryRow {
  readonly deliveryId: string;
  readonly boardId: string;
  readonly ticketId: string;
  readonly ruleId: string;
  readonly eventSequence: number;
  readonly connectionRef: string;
  readonly formatter: string;
  readonly contextJson: string;
  readonly deliveryState: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
}

const deliveryRows = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<DeliveryRow>`
      SELECT
        delivery_id AS "deliveryId",
        board_id AS "boardId",
        ticket_id AS "ticketId",
        rule_id AS "ruleId",
        event_sequence AS "eventSequence",
        connection_ref AS "connectionRef",
        formatter,
        context_json AS "contextJson",
        delivery_state AS "deliveryState",
        attempt_count AS "attemptCount",
        next_attempt_at AS "nextAttemptAt"
      FROM workflow_outbound_delivery
      WHERE ticket_id = ${ticketId}
      ORDER BY rule_id ASC
    `;
  });

const eventSequence = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM workflow_events WHERE ticket_id = ${ticketId} ORDER BY sequence ASC
    `;
    return rows;
  });

layer("WorkflowEventCommitter outbound", (it) => {
  it.effect("writes exactly one delivery row for a matching, enabled rule", () =>
    Effect.gen(function* () {
      const boardId = "b-out-blocked";
      const ticketId = "t-out-blocked";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId, [
        { id: "r1", on: "blocked", to: "conn-1", as: "slack", enabled: true },
        { id: "r2", on: "done", to: "conn-1", as: "generic", enabled: true },
        { id: "r3", on: "blocked", to: "conn-1", as: "slack", enabled: false },
      ]);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Blocked T", status: "running" });

      yield* committer.commit({
        type: "TicketBlocked",
        eventId: "e-out-blocked" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { reason: "dep missing" },
      });

      const rows = yield* deliveryRows(ticketId);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.ruleId, "r1");
      assert.equal(row.connectionRef, "conn-1");
      assert.equal(row.formatter, "slack");
      assert.equal(row.deliveryState, "pending");
      assert.equal(row.attemptCount, 0);
      assert.isNull(row.nextAttemptAt);

      const seq = yield* eventSequence(ticketId);
      assert.equal(row.deliveryId, `dlv-${seq[0]!.sequence}-r1`);
      assert.equal(row.eventSequence, seq[0]!.sequence);

      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the stored context_json for assertions in a test.
      const ctx = JSON.parse(row.contextJson) as Record<string, unknown>;
      assert.equal(ctx.trigger, "blocked");
      assert.equal(ctx.reason, "dep missing");
      assert.equal(ctx.ticketId, ticketId);
      assert.equal(ctx.boardId, boardId);
    }),
  );

  it.effect("evaluates a when-predicate and writes only when it matches", () =>
    Effect.gen(function* () {
      const boardId = "b-out-when";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId, [
        {
          id: "r-when",
          on: "lane_entered",
          when: { "==": [{ var: "toLane" }, "needs-attention"] },
          to: "conn-1",
          as: "generic",
          enabled: true,
        },
      ]);

      // Move into needs-attention → predicate true → 1 row.
      const matchTicket = "t-out-when-match";
      yield* insertProjectedTicket({
        ticketId: matchTicket,
        boardId,
        title: "Match",
        lane: "impl",
      });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-out-when-match" as never,
        ticketId: matchTicket as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "needs-attention" as never,
          laneEntryToken: "tok-match" as never,
          reason: "routed",
        },
      });
      assert.equal((yield* deliveryRows(matchTicket)).length, 1);

      // Move into in-progress → predicate false → 0 rows.
      const missTicket = "t-out-when-miss";
      yield* insertProjectedTicket({ ticketId: missTicket, boardId, title: "Miss", lane: "impl" });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-out-when-miss" as never,
        ticketId: missTicket as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          toLane: "in-progress" as never,
          laneEntryToken: "tok-miss" as never,
          reason: "routed",
        },
      });
      assert.equal((yield* deliveryRows(missTicket)).length, 0);
    }),
  );

  it.effect("a `done` rule fires only on entry into a terminal lane", () =>
    Effect.gen(function* () {
      const boardId = "b-out-done";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId, [
        { id: "r-done", on: "done", to: "conn-1", as: "generic", enabled: true },
      ]);

      // Into terminal lane → 1 row.
      const termTicket = "t-out-done-term";
      yield* insertProjectedTicket({ ticketId: termTicket, boardId, title: "Term", lane: "impl" });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-out-done-term" as never,
        ticketId: termTicket as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "shipped" as never,
          laneEntryToken: "tok-term" as never,
          reason: "routed",
        },
      });
      const termRows = yield* deliveryRows(termTicket);
      assert.equal(termRows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the stored context_json for assertions in a test.
      const ctx = JSON.parse(termRows[0]!.contextJson) as Record<string, unknown>;
      assert.equal(ctx.isTerminal, true);
      // A rule matched as `done` stores trigger="done" (not the lane_entered label).
      assert.equal(ctx.trigger, "done");

      // Into a non-terminal lane → 0 rows.
      const nonTermTicket = "t-out-done-nonterm";
      yield* insertProjectedTicket({
        ticketId: nonTermTicket,
        boardId,
        title: "NonTerm",
        lane: "impl",
      });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-out-done-nonterm" as never,
        ticketId: nonTermTicket as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          toLane: "in-progress" as never,
          laneEntryToken: "tok-nonterm" as never,
          reason: "routed",
        },
      });
      assert.equal((yield* deliveryRows(nonTermTicket)).length, 0);
    }),
  );

  it.effect(
    'a `done` rule with a trigger=="done" predicate matches on a terminal move, not a non-terminal one',
    () =>
      Effect.gen(function* () {
        const boardId = "b-out-done-pred";
        const committer = yield* WorkflowEventCommitter;
        // The board-editor UI suggests exactly this predicate for `done` rules.
        yield* registerBoard(boardId, [
          {
            id: "r-done-pred",
            on: "done",
            when: { "==": [{ var: "trigger" }, "done"] },
            to: "conn-1",
            as: "generic",
            enabled: true,
          },
        ]);

        // Into a terminal lane → matchesTrigger passes, ruleCtx.trigger === "done"
        // → predicate true → 1 row, stored trigger is "done".
        const termTicket = "t-out-done-pred-term";
        yield* insertProjectedTicket({
          ticketId: termTicket,
          boardId,
          title: "Term",
          lane: "impl",
        });
        yield* committer.commit({
          type: "TicketMovedToLane",
          eventId: "e-out-done-pred-term" as never,
          ticketId: termTicket as never,
          occurredAt: "2026-06-07T00:00:01.000Z" as never,
          payload: {
            toLane: "shipped" as never,
            laneEntryToken: "tok-done-pred-term" as never,
            reason: "routed",
          },
        });
        const termRows = yield* deliveryRows(termTicket);
        assert.equal(termRows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the stored context_json for assertions in a test.
        const ctx = JSON.parse(termRows[0]!.contextJson) as Record<string, unknown>;
        assert.equal(ctx.trigger, "done");

        // Into a non-terminal lane → matchesTrigger fails → 0 rows.
        const nonTermTicket = "t-out-done-pred-nonterm";
        yield* insertProjectedTicket({
          ticketId: nonTermTicket,
          boardId,
          title: "NonTerm",
          lane: "impl",
        });
        yield* committer.commit({
          type: "TicketMovedToLane",
          eventId: "e-out-done-pred-nonterm" as never,
          ticketId: nonTermTicket as never,
          occurredAt: "2026-06-07T00:00:02.000Z" as never,
          payload: {
            toLane: "in-progress" as never,
            laneEntryToken: "tok-done-pred-nonterm" as never,
            reason: "routed",
          },
        });
        assert.equal((yield* deliveryRows(nonTermTicket)).length, 0);
      }),
  );

  it.effect("the stored context occurredAt is the event's occurrence time, not commit time", () =>
    Effect.gen(function* () {
      const boardId = "b-out-occurred";
      const ticketId = "t-out-occurred";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId, [
        { id: "r-any", on: "lane_entered", to: "conn-1", as: "generic", enabled: true },
      ]);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Occurred", lane: "impl" });

      // A distinct, known occurrence time — deliberately not "now"/commit time.
      const eventOccurredAt = "2024-01-02T03:04:05.000Z";
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-out-occurred" as never,
        ticketId: ticketId as never,
        occurredAt: eventOccurredAt as never,
        payload: {
          toLane: "in-progress" as never,
          laneEntryToken: "tok-occurred" as never,
          reason: "routed",
        },
      });

      const rows = yield* deliveryRows(ticketId);
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the stored context_json for assertions in a test.
      const ctx = JSON.parse(rows[0]!.contextJson) as Record<string, unknown>;
      assert.equal(ctx.occurredAt, eventOccurredAt);
    }),
  );

  it.effect("re-running the same supersede+insert for one sequence stays exactly-once", () =>
    Effect.gen(function* () {
      // The event store enforces UNIQUE(event_id), so a duplicate commit fails at
      // append before reaching the outbound path. Exercise the INSERT OR IGNORE +
      // UNIQUE(event_sequence, rule_id) directly: a re-insert at the same
      // (sequence, ruleId) must not create a second row.
      const boardId = "b-out-idem";
      const ticketId = "t-out-idem";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId, [
        { id: "r1", on: "blocked", to: "conn-1", as: "slack", enabled: true },
      ]);
      yield* insertProjectedTicket({ ticketId, boardId, title: "Idem", status: "running" });

      yield* committer.commit({
        type: "TicketBlocked",
        eventId: "e-out-idem" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { reason: "first" },
      });

      const rows = yield* deliveryRows(ticketId);
      assert.equal(rows.length, 1);
      const seq = rows[0]!.eventSequence;

      // Replay the exact same deterministic insert for the same (sequence, rule).
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT OR IGNORE INTO workflow_outbound_delivery (
          delivery_id, board_id, ticket_id, rule_id, event_sequence,
          connection_ref, formatter, context_json, delivery_state, attempt_count,
          next_attempt_at, created_at
        ) VALUES (
          ${`dlv-${seq}-r1`}, ${boardId}, ${ticketId}, 'r1', ${seq},
          'conn-1', 'slack', '{}', 'pending', 0, NULL, '2026-06-07T00:00:02.000Z'
        )
      `;
      assert.equal((yield* deliveryRows(ticketId)).length, 1);
    }),
  );

  it.effect("the stored context fromLane is the ticket's PRE-move lane", () =>
    Effect.gen(function* () {
      const boardId = "b-out-fromlane";
      const ticketId = "t-out-fromlane";
      const committer = yield* WorkflowEventCommitter;
      yield* registerBoard(boardId, [
        { id: "r-any", on: "lane_entered", to: "conn-1", as: "generic", enabled: true },
      ]);
      // Ticket currently sits in "impl".
      yield* insertProjectedTicket({ ticketId, boardId, title: "FromLane", lane: "impl" });

      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "e-out-fromlane" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "in-progress" as never,
          laneEntryToken: "tok-fromlane" as never,
          reason: "routed",
        },
      });

      const rows = yield* deliveryRows(ticketId);
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoding the stored context_json for assertions in a test.
      const ctx = JSON.parse(rows[0]!.contextJson) as Record<string, unknown>;
      assert.equal(ctx.fromLane, "impl");
      assert.equal(ctx.toLane, "in-progress");
    }),
  );
});

it.effect("a predicate-eval error skips the rule without failing the commit", () =>
  Effect.gen(function* () {
    const boardId = "b-out-evalerr";
    const ticketId = "t-out-evalerr";
    const committer = yield* WorkflowEventCommitter;
    // A registrable rule with a valid static `when`. The injected evaluator
    // forces a runtime eval error: the rule must be skipped, but the commit
    // (append + projection) must still succeed and no delivery row is written.
    yield* registerBoard(boardId, [
      {
        id: "r-err",
        on: "blocked",
        when: { "==": [{ var: "toLane" }, "x"] },
        to: "conn-1",
        as: "slack",
        enabled: true,
      },
    ]);
    yield* insertProjectedTicket({ ticketId, boardId, title: "EvalErr", status: "running" });

    const exit = yield* Effect.exit(
      committer.commit({
        type: "TicketBlocked",
        eventId: "e-out-evalerr" as never,
        ticketId: ticketId as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { reason: "boom" },
      }),
    );
    assert.isTrue(exit._tag === "Success");

    // Event persisted + projection applied (status flipped to blocked) ...
    const seq = yield* eventSequence(ticketId);
    assert.equal(seq.length, 1);
    const sql = yield* SqlClient.SqlClient;
    const tickets = yield* sql<{ readonly status: string }>`
        SELECT status FROM projection_ticket WHERE ticket_id = ${ticketId}
      `;
    assert.equal(tickets[0]?.status, "blocked");
    // ... but the erroring rule produced no delivery row.
    assert.equal((yield* deliveryRows(ticketId)).length, 0);
  }).pipe(Effect.provide(failingEvaluatorLayer)),
);
