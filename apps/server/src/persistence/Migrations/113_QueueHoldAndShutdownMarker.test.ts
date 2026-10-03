import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./113_QueueHoldAndShutdownMarker.ts";

const withMemoryDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql(table)})`;
  });

const seedQueuedTurn = Effect.fnUntraced(function* (input: {
  readonly queuedTurnId: string;
  readonly threadId: string;
  readonly createdAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_queued_turns (
      queued_turn_id,
      thread_id,
      message_id,
      text,
      attachments_json,
      runtime_mode,
      interaction_mode,
      created_at,
      updated_at
    )
    VALUES (
      ${input.queuedTurnId},
      ${input.threadId},
      ${`${input.queuedTurnId}-message`},
      'queued',
      '[]',
      'full-access',
      'default',
      ${input.createdAt},
      ${input.createdAt}
    )
  `;
});

const readPositions = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: string; readonly position: number }>`
      SELECT queued_turn_id AS id, queue_position AS position
      FROM projection_queued_turns
      WHERE thread_id = ${threadId}
      ORDER BY queue_position ASC
    `;
  });

it.effect("adds the queue columns and shutdown marker during a normal upgrade", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 112 });
      yield* migration;

      assert.isTrue(
        (yield* columnsOf("projection_threads")).some((c) => c.name === "queue_held_at"),
      );
      assert.isTrue(
        (yield* columnsOf("projection_queued_turns")).some((c) => c.name === "queue_position"),
      );
      const marker = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly clean_shutdown_at: string }>`
          SELECT clean_shutdown_at FROM server_shutdown_marker WHERE id = 1
        `;
      });
      assert.deepStrictEqual(marker, [{ clean_shutdown_at: "" }]);
    }),
  ),
);

it.effect("is idempotent when replayed against an already-migrated database", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 112 });
      yield* migration;
      yield* migration;

      assert.strictEqual(
        (yield* columnsOf("projection_threads")).filter((c) => c.name === "queue_held_at").length,
        1,
      );
      assert.strictEqual(
        (yield* columnsOf("projection_queued_turns")).filter((c) => c.name === "queue_position")
          .length,
        1,
      );
    }),
  ),
);

it.effect("backfills queue_position from existing creation order per thread", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 112 });
      // Newest first on purpose: the backfill must reassign positions by
      // creation order, not preserve insertion order.
      yield* seedQueuedTurn({
        queuedTurnId: "turn-c",
        threadId: "thread-1",
        createdAt: "2026-01-03T00:00:00Z",
      });
      yield* seedQueuedTurn({
        queuedTurnId: "turn-a",
        threadId: "thread-1",
        createdAt: "2026-01-01T00:00:00Z",
      });
      yield* seedQueuedTurn({
        queuedTurnId: "turn-b",
        threadId: "thread-1",
        createdAt: "2026-01-02T00:00:00Z",
      });
      yield* seedQueuedTurn({
        queuedTurnId: "other-a",
        threadId: "thread-2",
        createdAt: "2026-01-01T00:00:00Z",
      });

      yield* migration;

      const threadOne = yield* readPositions("thread-1");
      assert.deepStrictEqual(threadOne, [
        { id: "turn-a", position: 0 },
        { id: "turn-b", position: 1 },
        { id: "turn-c", position: 2 },
      ]);
      // Positions restart per thread rather than continuing across threads.
      const threadTwo = yield* readPositions("thread-2");
      assert.deepStrictEqual(threadTwo, [{ id: "other-a", position: 0 }]);
    }),
  ),
);

it.effect("breaks same-timestamp ties deterministically by queued turn id", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 112 });
      const sameInstant = "2026-01-01T00:00:00Z";
      for (const id of ["turn-z", "turn-m", "turn-a"]) {
        yield* seedQueuedTurn({ queuedTurnId: id, threadId: "thread-1", createdAt: sameInstant });
      }

      yield* migration;

      const positions = yield* readPositions("thread-1");
      assert.deepStrictEqual(positions, [
        { id: "turn-a", position: 0 },
        { id: "turn-m", position: 1 },
        { id: "turn-z", position: 2 },
      ]);
    }),
  ),
);
