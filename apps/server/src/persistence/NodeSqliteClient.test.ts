import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );
});

it.effect("executes file-backed queries without blocking the Node event loop", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "t3-node-sqlite-worker-"))),
    (directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
          yield* sql`INSERT INTO entries(name) VALUES (${"committed"})`;

          const transactionExit = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO entries(name) VALUES (${"rolled-back"})`;
                return yield* Effect.fail("rollback");
              }),
            ),
          );
          assert.equal(transactionExit._tag, "Failure");
          assert.deepStrictEqual(
            yield* sql<{ readonly name: string }>`SELECT name FROM entries ORDER BY id`,
            [{ name: "committed" }],
          );
          yield* sql`
            WITH input(name) AS (SELECT ${"cte-write"})
            INSERT INTO entries(name) SELECT name FROM input
          `;
          assert.deepStrictEqual(
            yield* sql<{ readonly name: string }>`SELECT name FROM entries ORDER BY id`,
            [{ name: "committed" }, { name: "cte-write" }],
          );

          let timerFired = false;
          const timer = setTimeout(() => {
            timerFired = true;
          }, 20);

          let readFinished = false;
          const readFiber = yield* Effect.forkChild(
            sql`
                WITH RECURSIVE counter(value) AS (
                  SELECT 1
                  UNION ALL
                  SELECT value + 1 FROM counter WHERE value < 4000000
                )
                SELECT SUM(value) AS total FROM counter
              `.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  readFinished = true;
                }),
              ),
            ),
          );
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
          yield* sql`INSERT INTO entries(name) VALUES (${"concurrent-write"})`;
          clearTimeout(timer);

          assert.isTrue(timerFired);
          assert.isFalse(readFinished);
          yield* Fiber.join(readFiber);
        }).pipe(
          Effect.provide(
            SqliteClient.layer({
              filename: join(directory, "event-loop.sqlite"),
            }),
          ),
        ),
      ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ),
);
