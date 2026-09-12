import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { rm } from "node:fs/promises"

const isBun = "bun" in process.versions

describe("Client", () => {
  it.effect("should work", () => Effect.void)

  it.effect.skipIf(!isBun)("uses a 5 second busy timeout", () =>
    Effect.gen(function*() {
      const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"))
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      assert.deepStrictEqual(yield* sql`PRAGMA busy_timeout`, [{ timeout: 5000 }])

      const custom = yield* SqliteClient.make({ filename: ":memory:", busyTimeout: "1 second" })
      assert.deepStrictEqual(yield* custom`PRAGMA busy_timeout`, [{ timeout: 1000 }])

      const infinite = yield* SqliteClient.make({ filename: ":memory:", busyTimeout: Duration.infinity })
      assert.deepStrictEqual(yield* infinite`PRAGMA busy_timeout`, [{ timeout: 2_147_483_647 }])
    }).pipe(Effect.provide(Reactivity.layer)))

  it.effect.skipIf(!isBun)("starts transactions immediately", () =>
    Effect.gen(function*() {
      const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"))
      const filename = `/tmp/effect-sqlite-bun-transaction-${crypto.randomUUID()}.db`
      yield* Effect.acquireRelease(
        Effect.void,
        () => Effect.promise(() => rm(filename, { force: true }))
      )

      const client = yield* SqliteClient.make({ filename })
      const contender = yield* SqliteClient.make({ filename })
      yield* contender`PRAGMA busy_timeout = 1`

      yield* client.withTransaction(
        Effect.gen(function*() {
          const error = yield* Effect.flip(contender`BEGIN IMMEDIATE`)
          assert.strictEqual(error._tag, "SqlError")
          assert(error.reason.cause instanceof Error)
          assert.match(error.reason.cause.message, /database is locked/i)
        })
      )
    }).pipe(Effect.provide(Reactivity.layer)))

  it.effect.skipIf(!isBun)("readonly clients reject writes", () =>
    Effect.gen(function*() {
      const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"))
      const filename = `/tmp/effect-sqlite-bun-readonly-${crypto.randomUUID()}.db`
      yield* Effect.acquireRelease(
        Effect.void,
        () => Effect.promise(() => rm(filename, { force: true }))
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* SqliteClient.make({ filename })
          yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY)`
        })
      )

      const sql = yield* SqliteClient.make({ filename, readonly: true })
      assert.deepStrictEqual(yield* sql`SELECT * FROM test`, [])
      assert.deepStrictEqual(yield* sql.withTransaction(sql`SELECT * FROM test`), [])

      const error = yield* Effect.flip(sql`INSERT INTO test DEFAULT VALUES`)
      assert.strictEqual(error._tag, "SqlError")
      assert(error.reason.cause instanceof Error)
      assert.match(error.reason.cause.message, /attempt to write a readonly database/i)
    }).pipe(Effect.provide(Reactivity.layer)))
})
