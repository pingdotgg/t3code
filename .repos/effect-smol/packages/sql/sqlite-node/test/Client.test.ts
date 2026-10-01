import { NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, FileSystem, Option } from "effect"
import { Reactivity } from "effect/unstable/reactivity"

const makeClient = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  return yield* SqliteClient.make({
    filename: dir + "/test.db"
  })
}).pipe(Effect.provide([NodeFileSystem.layer, Reactivity.layer]))

const makeClients = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  const filename = dir + "/test.db"
  return {
    client: yield* SqliteClient.make({ filename }),
    contender: yield* SqliteClient.make({ filename })
  }
}).pipe(Effect.provide([NodeFileSystem.layer, Reactivity.layer]))

describe("Client", () => {
  it.effect("should work", () =>
    Effect.gen(function*() {
      const sql = yield* makeClient
      let response
      response = yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      assert.deepStrictEqual(response, [])
      response = yield* sql`INSERT INTO test (name) VALUES ('hello')`
      assert.deepStrictEqual(response, [])
      response = yield* sql`SELECT * FROM test`
      assert.deepStrictEqual(response, [{ id: 1, name: "hello" }])
      response = yield* sql`SELECT * FROM test`.valuesUnprepared
      assert.deepStrictEqual(response, [[1, "hello"]])
      response = yield* sql`INSERT INTO test (name) VALUES ('world')`.pipe(sql.withTransaction)
      assert.deepStrictEqual(response, [])
      response = yield* sql`SELECT * FROM test`
      assert.deepStrictEqual(response, [
        { id: 1, name: "hello" },
        { id: 2, name: "world" }
      ])
    }))

  it.effect("should work with raw", () =>
    Effect.gen(function*() {
      const sql = yield* makeClient
      let response
      response = yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`.raw
      assert.deepStrictEqual(response, { changes: 0, lastInsertRowid: 0 })
      response = yield* sql`INSERT INTO test (name) VALUES ('hello')`.raw
      assert.deepStrictEqual(response, { changes: 1, lastInsertRowid: 1 })
      response = yield* sql`SELECT * FROM test`.raw
      assert.deepStrictEqual(response, [{ id: 1, name: "hello" }])
      response = yield* sql`INSERT INTO test (name) VALUES ('world')`.raw.pipe(sql.withTransaction)
      assert.deepStrictEqual(response, { changes: 1, lastInsertRowid: 2 })
      response = yield* sql`SELECT * FROM test`
      assert.deepStrictEqual(response, [
        { id: 1, name: "hello" },
        { id: 2, name: "world" }
      ])
    }))

  for (const mode of ["unprepared", "valuesUnprepared"] as const) {
    it.effect(`captures ${mode} preparation errors`, () =>
      Effect.gen(function*() {
        const sql = yield* makeClient
        yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY)`

        const statement = sql`CREATE TABLE test (id INTEGER PRIMARY KEY)`
        const execution = mode === "unprepared"
          ? Effect.as(statement.unprepared, false)
          : Effect.as(statement.valuesUnprepared, false)
        const recovered = yield* execution.pipe(Effect.catchTag("SqlError", () => Effect.succeed(true)))

        assert.isTrue(recovered)
      }))
  }

  it.effect("withTransaction", () =>
    Effect.gen(function*() {
      const sql = yield* makeClient
      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      yield* sql.withTransaction(sql`INSERT INTO test (name) VALUES ('hello')`)
      const rows = yield* sql`SELECT * FROM test`
      assert.deepStrictEqual(rows, [{ id: 1, name: "hello" }])
    }))

  it.effect("withTransaction rollback", () =>
    Effect.gen(function*() {
      const sql = yield* makeClient
      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      yield* sql`INSERT INTO test (name) VALUES ('hello')`.pipe(
        Effect.andThen(Effect.fail("boom")),
        sql.withTransaction,
        Effect.ignore
      )
      const rows = yield* sql`SELECT * FROM test`
      assert.deepStrictEqual(rows, [])
    }))

  it.effect("uses a 5 second busy timeout", () =>
    Effect.gen(function*() {
      const sql = yield* makeClient
      assert.deepStrictEqual(yield* sql`PRAGMA busy_timeout`, [{ timeout: 5000 }])

      const custom = yield* SqliteClient.make({ filename: ":memory:", busyTimeout: "1 second" }).pipe(
        Effect.provide(Reactivity.layer)
      )
      assert.deepStrictEqual(yield* custom`PRAGMA busy_timeout`, [{ timeout: 1000 }])

      const infinite = yield* SqliteClient.make({ filename: ":memory:", busyTimeout: Duration.infinity }).pipe(
        Effect.provide(Reactivity.layer)
      )
      assert.deepStrictEqual(yield* infinite`PRAGMA busy_timeout`, [{ timeout: 2_147_483_647 }])
    }))

  it.effect("starts transactions immediately", () =>
    Effect.gen(function*() {
      const { client, contender } = yield* makeClients
      yield* contender`PRAGMA busy_timeout = 1`

      yield* client.withTransaction(
        Effect.gen(function*() {
          const error = yield* Effect.flip(contender`BEGIN IMMEDIATE`)
          assert.strictEqual(error._tag, "SqlError")
          assert(error.reason.cause instanceof Error)
          assert.match(error.reason.cause.message, /database is locked/i)
        })
      )
    }))

  it.effect("fails a contended transaction with a typed error", () =>
    Effect.gen(function*() {
      const { client, contender } = yield* makeClients
      yield* contender`PRAGMA busy_timeout = 1`

      const exit = yield* client.withTransaction(
        Effect.exit(contender.withTransaction(Effect.void))
      )

      assert.isTrue(Exit.isFailure(exit))
      if (!Exit.isFailure(exit)) {
        return
      }
      // `BEGIN IMMEDIATE` cannot take the write lock, so it fails before a
      // transaction exists. The failure has to stay a typed, retryable
      // `SqlError` instead of being replaced by a rollback defect.
      assert.isFalse(
        Cause.hasDies(exit.cause),
        `expected a typed failure but the cause contains a defect:\n${Cause.pretty(exit.cause)}`
      )
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      assert.strictEqual(error._tag, "SqlError")
      assert(error.reason.cause instanceof Error)
      assert.match(error.reason.cause.message, /database is locked/i)
    }))

  it.effect("supports transactions on readonly clients", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filename = dir + "/test.db"

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* SqliteClient.make({ filename })
          yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY)`
        })
      )

      const sql = yield* SqliteClient.make({ filename, readonly: true })
      yield* sql`PRAGMA query_only = ON`
      assert.deepStrictEqual(yield* sql.withTransaction(sql`SELECT * FROM test`), [])
    }).pipe(Effect.provide([NodeFileSystem.layer, Reactivity.layer])))

  it.effect("supports backup and export", () =>
    Effect.gen(function*() {
      const sql = yield* makeClient
      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      yield* sql`INSERT INTO test (name) VALUES ('hello')`

      const metadata = yield* sql.backup(sql.config.filename + ".backup")
      assert(metadata.totalPages > 0)
      assert.strictEqual(metadata.remainingPages, 0)
    }))
})
