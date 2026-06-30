import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import {
  ProviderDispatchOutbox,
  ProviderTurnPort,
  type DispatchRequest,
} from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { ProviderDispatchOutboxLive } from "./ProviderDispatchOutbox.ts";

const request = {
  dispatchId: "dispatch-1" as never,
  ticketId: "ticket-1" as never,
  stepRunId: "step-run-1" as never,
  threadId: "thread-1" as never,
  providerInstance: "codex",
  model: "gpt-5.5",
  instruction: "Implement the next workflow step",
  worktreePath: "/tmp/workflow-ticket-1",
} satisfies DispatchRequest;

it.effect("starts provider dispatch idempotently and confirms from terminal turn state", () =>
  Effect.gen(function* () {
    const providerCalls = yield* Ref.make(0);
    const turnReads = yield* Ref.make(0);

    const layer = ProviderDispatchOutboxLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: () =>
            Ref.update(providerCalls, (count) => count + 1).pipe(
              Effect.as({ turnId: "turn-1" as never }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () =>
            Ref.updateAndGet(turnReads, (count) => count + 1).pipe(
              Effect.map((count) =>
                count === 1 ? ({ _tag: "running" } as const) : ({ _tag: "completed" } as const),
              ),
            ),
        }),
      ),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;
      const sql = yield* SqlClient.SqlClient;

      yield* outbox.ensureStarted(request);
      yield* outbox.ensureStarted(request);

      assert.equal(yield* Ref.get(providerCalls), 1);

      const started = yield* sql<{ readonly status: string; readonly turnId: string | null }>`
        SELECT status, turn_id AS "turnId"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = ${request.dispatchId}
      `;
      assert.equal(started[0]?.status, "started");
      assert.equal(started[0]?.turnId, "turn-1");

      const terminalFiber = yield* Effect.forkChild(
        outbox.awaitTerminal(request.dispatchId, request.threadId),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const terminal = yield* Fiber.join(terminalFiber);
      assert.deepEqual(terminal, { ok: true });

      const confirmed = yield* sql<{ readonly status: string }>`
        SELECT status FROM workflow_dispatch_outbox WHERE dispatch_id = ${request.dispatchId}
      `;
      assert.equal(confirmed[0]?.status, "confirmed");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("confirms the outbox row when the terminal wait times out", () =>
  Effect.gen(function* () {
    const layer = ProviderDispatchOutboxLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "running" as const }),
        }),
      ),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;
      const sql = yield* SqlClient.SqlClient;

      yield* outbox.ensureStarted(request);

      const terminalFiber = yield* Effect.forkChild(
        outbox.awaitTerminal(request.dispatchId, request.threadId),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 minutes");
      const terminal = yield* Fiber.join(terminalFiber);
      assert.deepEqual(terminal, {
        ok: false,
        error: "turn did not reach a terminal state before timeout",
      });

      // The timed-out row must be settled so restart recovery never
      // re-dispatches a step the pipeline already failed.
      const confirmed = yield* sql<{ readonly status: string }>`
        SELECT status FROM workflow_dispatch_outbox WHERE dispatch_id = ${request.dispatchId}
      `;
      assert.equal(confirmed[0]?.status, "confirmed");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("looks up dispatch thread and turn by step run", () =>
  Effect.gen(function* () {
    const layer = ProviderDispatchOutboxLive.pipe(
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
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;

      yield* outbox.ensureStarted(request);

      const dispatch = yield* outbox.getDispatchForStep(request.stepRunId);
      assert.deepEqual(dispatch, {
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }).pipe(Effect.provide(layer));
  }),
);

const agentOptions = [
  { id: "effort", value: "high" },
  { id: "thinking", value: true },
];

it.effect("persists agent option selections as JSON on dispatch", () =>
  Effect.gen(function* () {
    const layer = ProviderDispatchOutboxLive.pipe(
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
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;
      const sql = yield* SqlClient.SqlClient;

      yield* outbox.ensureStarted({ ...request, options: agentOptions });

      const stored = yield* sql<{ readonly optionsJson: string | null }>`
        SELECT options_json AS "optionsJson"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = ${request.dispatchId}
      `;
      const optionsJson = stored[0]?.optionsJson ?? null;
      assert.isNotNull(optionsJson);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - test asserts the persisted JSON shape.
      assert.deepEqual(JSON.parse(optionsJson!), agentOptions);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("replays persisted agent options to the provider on recovery", () =>
  Effect.gen(function* () {
    const replayed = yield* Ref.make<ReadonlyArray<DispatchRequest>>([]);
    const layer = ProviderDispatchOutboxLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: (req: DispatchRequest) =>
            Ref.update(replayed, (all) => [...all, req]).pipe(
              Effect.as({ turnId: "turn-1" as never }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "completed" as const }),
        }),
      ),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_board (
          board_id, project_id, name, workflow_file_path, workflow_version_hash, max_concurrent_tickets
        )
        VALUES ('board-1', 'project-1', 'Board', '.t3/board.toml', 'hash-1', 1)
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES (
          ${request.ticketId}, 'board-1', 'Ticket', 'implement', 'active',
          '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id, ticket_id, step_run_id, thread_id,
          provider_instance, model, instruction, worktree_path, options_json, status, created_at
        )
        VALUES (
          ${request.dispatchId}, ${request.ticketId}, ${request.stepRunId}, ${request.threadId},
          ${request.providerInstance}, ${request.model}, ${request.instruction}, ${request.worktreePath},
          '[{"id":"effort","value":"high"},{"id":"thinking","value":true}]',
          'pending', '2026-06-09T00:00:00.000Z'
        )
      `;

      yield* outbox.recoverPending();

      const all = yield* Ref.get(replayed);
      assert.equal(all.length, 1);
      assert.deepEqual(all[0]?.options, agentOptions);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("recovers dispatches without options as plain requests", () =>
  Effect.gen(function* () {
    const replayed = yield* Ref.make<ReadonlyArray<DispatchRequest>>([]);
    const layer = ProviderDispatchOutboxLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: (req: DispatchRequest) =>
            Ref.update(replayed, (all) => [...all, req]).pipe(
              Effect.as({ turnId: "turn-1" as never }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "completed" as const }),
        }),
      ),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_board (
          board_id, project_id, name, workflow_file_path, workflow_version_hash, max_concurrent_tickets
        )
        VALUES ('board-1', 'project-1', 'Board', '.t3/board.toml', 'hash-1', 1)
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES (
          ${request.ticketId}, 'board-1', 'Ticket', 'implement', 'active',
          '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id, ticket_id, step_run_id, thread_id,
          provider_instance, model, instruction, worktree_path, options_json, status, created_at
        )
        VALUES (
          ${request.dispatchId}, ${request.ticketId}, ${request.stepRunId}, ${request.threadId},
          ${request.providerInstance}, ${request.model}, ${request.instruction}, ${request.worktreePath},
          NULL, 'pending', '2026-06-09T00:00:00.000Z'
        )
      `;

      yield* outbox.recoverPending();

      const all = yield* Ref.get(replayed);
      assert.equal(all.length, 1);
      assert.equal(all[0]?.options, undefined);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("deletes pending dispatches whose ticket projection no longer exists", () =>
  Effect.gen(function* () {
    const providerCalls = yield* Ref.make(0);
    const layer = ProviderDispatchOutboxLive.pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderTurnPort, {
          ensureTurnStarted: () =>
            Ref.update(providerCalls, (count) => count + 1).pipe(
              Effect.as({ turnId: "turn-orphan" as never }),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "completed" as const }),
        }),
      ),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const outbox = yield* ProviderDispatchOutbox;
      const sql = yield* SqlClient.SqlClient;

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
          'dispatch-orphan',
          'ticket-orphan',
          'step-orphan',
          'thread-orphan',
          'codex',
          'gpt-5.5',
          'do not start',
          '/tmp/orphan',
          'pending',
          '2026-06-07T00:00:00.000Z'
        )
      `;

      yield* outbox.recoverPending();

      assert.equal(yield* Ref.get(providerCalls), 0);
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-orphan'
      `;
      assert.equal(remaining[0]?.count, 0);
    }).pipe(Effect.provide(layer));
  }),
);
