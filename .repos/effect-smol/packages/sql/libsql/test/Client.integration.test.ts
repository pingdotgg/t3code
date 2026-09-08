import { LibsqlClient } from "@effect/sql-libsql"
import { assert, describe, it, layer } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { LibsqlContainer } from "./util.ts"

const Migrations = Layer.effectDiscard(
  LibsqlClient.LibsqlClient.pipe(
    Effect.andThen((sql) =>
      Effect.acquireRelease(
        sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`,
        () => sql`DROP TABLE test;`.pipe(Effect.ignore)
      )
    )
  )
)

describe("Client", () => {
  it.effect("releases transaction serialization after begin fails", () => {
    let transactionCalls = 0
    const transaction = {
      execute: () => Promise.resolve({ rows: [] }),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve()
    }
    const liveClient = {
      execute: () => Promise.resolve({ rows: [] }),
      transaction: () => {
        transactionCalls++
        return transactionCalls === 1
          ? Promise.reject(new Error("transient begin failure"))
          : Promise.resolve(transaction)
      }
    }

    return Effect.gen(function*() {
      const client = yield* LibsqlClient.make({ liveClient: liveClient as any })
      const first = yield* Effect.exit(client.withTransaction(Effect.void))
      assert.isTrue(Exit.isFailure(first))

      yield* Effect.forkChild(client.withTransaction(Effect.void))
      yield* Effect.yieldNow

      assert.strictEqual(transactionCalls, 2)
    }).pipe(
      Effect.scoped,
      Effect.provide(Reactivity.layer)
    )
  })

  layer(LibsqlContainer.layerClient, { timeout: "30 seconds" })((it) => {
    it.effect("should work", () =>
      Effect.gen(function*() {
        const sql = yield* LibsqlClient.LibsqlClient
        let response = yield* sql`INSERT INTO test (name) VALUES ('hello')`
        assert.deepStrictEqual(response, [])
        response = yield* sql`SELECT * FROM test`
        assert.deepStrictEqual(response, [{ id: 1, name: "hello" }])
        response = yield* sql`SELECT * FROM test`
        assert.deepStrictEqual(yield* sql`select * from test`.values, [
          [1, "hello"]
        ])
      }).pipe(Effect.provide(Migrations)))

    it.effect("should work with raw", () =>
      Effect.gen(function*() {
        const sql = yield* LibsqlClient.LibsqlClient
        let response: any
        response = yield* sql`CREATE TABLE test2 (id INTEGER PRIMARY KEY, name TEXT)`.raw
        yield* Effect.addFinalizer(() => sql`DROP TABLE test2;`.pipe(Effect.ignore))
        assert.deepStrictEqual(response.toJSON(), {
          columnTypes: [],
          columns: [],
          lastInsertRowid: null,
          rows: [],
          rowsAffected: 0
        })
        response = yield* sql`INSERT INTO test (name) VALUES ('hello')`.raw
        assert.deepStrictEqual(response.toJSON(), {
          columnTypes: [],
          columns: [],
          lastInsertRowid: "1",
          rows: [],
          rowsAffected: 1
        })
        response = yield* sql`SELECT * FROM test`.raw
        assert.deepStrictEqual(response.toJSON(), {
          columnTypes: ["INTEGER", "TEXT"],
          columns: ["id", "name"],
          lastInsertRowid: null,
          rows: [[1, "hello"]],
          rowsAffected: 0
        })
      }).pipe(Effect.provide(Migrations)))

    it.effect("withTransaction", () =>
      Effect.gen(function*() {
        const sql = yield* LibsqlClient.LibsqlClient
        yield* sql.withTransaction(sql`INSERT INTO test (name) VALUES ('hello')`)
        const rows = yield* sql`SELECT * FROM test`
        assert.deepStrictEqual(rows, [{ id: 1, name: "hello" }])
      }).pipe(Effect.provide(Migrations)))

    it.effect("withTransaction rollback", () =>
      Effect.gen(function*() {
        const sql = yield* LibsqlClient.LibsqlClient
        yield* sql`INSERT INTO test (name) VALUES ('hello')`.pipe(
          Effect.andThen(Effect.fail("boom")),
          sql.withTransaction,
          Effect.ignore
        )
        const rows = yield* sql`SELECT * FROM test`
        assert.deepStrictEqual(rows, [])
      }).pipe(Effect.provide(Migrations)))

    it.effect("withTransaction nested", () =>
      Effect.gen(function*() {
        const sql = yield* LibsqlClient.LibsqlClient
        const stmt = sql`INSERT INTO test (name) VALUES ('hello')`

        yield* stmt.pipe(Effect.andThen(() => stmt.pipe(sql.withTransaction)), sql.withTransaction)
        const rows = yield* sql<{ total_rows: number }>`select count(*) as total_rows FROM test`
        assert.deepStrictEqual(rows.at(0)?.total_rows, 2)
      }).pipe(Effect.provide(Migrations)))

    it.effect("withTransaction nested rollback", () =>
      Effect.gen(function*() {
        const sql = yield* LibsqlClient.LibsqlClient
        const stmt = sql`INSERT INTO test (name) VALUES ('hello')`

        yield* stmt.pipe(
          Effect.andThen(() => stmt.pipe(Effect.andThen(Effect.fail("boom")), sql.withTransaction, Effect.ignore)),
          sql.withTransaction
        )
        const rows = yield* sql<{ total_rows: number }>`select count(*) as total_rows FROM test`
        assert.deepStrictEqual(rows.at(0)?.total_rows, 1)
      }).pipe(Effect.provide(Migrations)))
  })
})
