import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, layer } from "@effect/vitest"
import { Effect } from "effect"

const ClientLayer = PgliteClient.layer({})

const setup = (table: string) =>
  Effect.gen(function*() {
    const sql = yield* PgliteClient.PgliteClient
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, name TEXT)`)
    yield* sql.unsafe(`TRUNCATE TABLE ${table} RESTART IDENTITY`)
    return sql
  })

describe("PgliteClient transactions", () => {
  layer(ClientLayer, { timeout: "30 seconds" })((it) => {
    it.effect("withTransaction commit", () =>
      Effect.gen(function*() {
        const sql = yield* setup("tx_commit")
        yield* sql.withTransaction(sql.unsafe(`INSERT INTO tx_commit (name) VALUES ('hello')`))
        const rows = yield* sql.unsafe<{ name: string }>(`SELECT name FROM tx_commit`)
        assert.deepStrictEqual(rows, [{ name: "hello" }])
      }))

    it.effect("withTransaction rollback", () =>
      Effect.gen(function*() {
        const sql = yield* setup("tx_rollback")
        yield* sql.unsafe(`INSERT INTO tx_rollback (name) VALUES ('hello')`).pipe(
          Effect.andThen(Effect.fail("boom")),
          sql.withTransaction,
          Effect.ignore
        )
        const rows = yield* sql.unsafe(`SELECT * FROM tx_rollback`)
        assert.deepStrictEqual(rows, [])
      }))

    it.effect("nested transaction commits both", () =>
      Effect.gen(function*() {
        const sql = yield* setup("tx_nested_commit")
        const stmt = sql.unsafe(`INSERT INTO tx_nested_commit (name) VALUES ('hello')`)
        yield* stmt.pipe(Effect.andThen(() => stmt.pipe(sql.withTransaction)), sql.withTransaction)
        const rows = yield* sql.unsafe<{ total: number }>(
          `SELECT count(*)::int AS total FROM tx_nested_commit`
        )
        assert.strictEqual(rows.at(0)?.total, 2)
      }))

    it.effect("nested transaction rollback via savepoint", () =>
      Effect.gen(function*() {
        const sql = yield* setup("tx_nested_rollback")
        const stmt = sql.unsafe(`INSERT INTO tx_nested_rollback (name) VALUES ('hello')`)
        yield* stmt.pipe(
          Effect.andThen(() => stmt.pipe(Effect.andThen(Effect.fail("boom")), sql.withTransaction, Effect.ignore)),
          sql.withTransaction
        )
        const rows = yield* sql.unsafe<{ total: number }>(
          `SELECT count(*)::int AS total FROM tx_nested_rollback`
        )
        assert.strictEqual(rows.at(0)?.total, 1)
      }))
  })
})
