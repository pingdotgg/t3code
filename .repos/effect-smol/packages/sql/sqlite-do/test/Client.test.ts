import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-do"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"

class FakeCursor {
  readonly columnNames: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>

  constructor(rows: ReadonlyArray<Record<string, unknown>>, columns?: ReadonlyArray<string>) {
    this.columnNames = columns ?? Object.keys(rows[0] ?? {})
    this.rows = rows.map((row) => this.columnNames.map((column) => row[column]))
  }

  *raw() {
    yield* this.rows.map((row) => [...row])
  }
}

class FakeSqlStorage {
  readonly statements: Array<string> = []
  tables = new Map<string, Array<Record<string, unknown>>>()
  columns = new Map<string, Array<string>>()

  snapshot() {
    return {
      tables: new Map(Array.from(this.tables, ([table, rows]) => [table, rows.map((row) => ({ ...row }))])),
      columns: new Map(Array.from(this.columns, ([table, columns]) => [table, [...columns]]))
    }
  }

  restore(snapshot: ReturnType<FakeSqlStorage["snapshot"]>) {
    this.tables = snapshot.tables
    this.columns = snapshot.columns
  }

  exec(sql: string, ...params: ReadonlyArray<unknown>) {
    this.statements.push(sql)
    const statement = normalizeSql(sql)
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(statement)) {
      throw new Error(`Unsupported transaction SQL: ${statement}`)
    }

    if (/^CREATE TABLE\b/i.test(statement)) {
      const match = /^CREATE TABLE(?: IF NOT EXISTS)?\s+("[^"]+"|\w+)\s*\((.*)\)$/i.exec(statement)
      if (match !== null) {
        const table = unquote(match[1])
        if (!this.tables.has(table)) {
          this.tables.set(table, [])
          this.columns.set(
            table,
            match[2].split(",").map((part) => unquote(part.trim().split(/\s+/)[0])).filter((column) =>
              column.length > 0 && column.toUpperCase() !== "PRIMARY"
            )
          )
        }
      }
      return new FakeCursor([])
    }

    if (/^INSERT INTO\b/i.test(statement)) {
      const match = /^INSERT INTO\s+("[^"]+"|\w+)\s*\(([^)]+)\)\s+VALUES\s+(.+)$/i.exec(statement)
      if (match !== null) {
        const table = unquote(match[1])
        const columns = match[2].split(",").map((column) => unquote(column.trim()))
        const rows = this.tables.get(table) ?? []
        const tableColumns = this.columns.get(table) ?? [...columns]
        if (!this.tables.has(table)) {
          this.tables.set(table, rows)
          this.columns.set(table, tableColumns)
        }
        let paramIndex = 0
        for (const group of valueGroups(match[3])) {
          const values = group.split(",").map((value) => parseValue(value.trim(), params, () => paramIndex++))
          const row: Record<string, unknown> = {}
          if (tableColumns.includes("id") && !columns.includes("id")) {
            row.id = rows.length + 1
          }
          for (let i = 0; i < columns.length; i++) {
            row[columns[i]] = values[i]
          }
          if (tableColumns.includes("created_at") && row.created_at === undefined) {
            row.created_at = "current_timestamp"
          }
          rows.push(row)
        }
      }
      return new FakeCursor([])
    }

    if (/^SELECT\b/i.test(statement)) {
      const match =
        /^SELECT\s+(.+)\s+FROM\s+("[^"]+"|\w+)(?:\s+WHERE\s+("[^"]+"|\w+)\s*=\s*(\?|('[^']*')|\d+))?(?:\s+ORDER BY\s+("[^"]+"|\w+)\s+DESC)?$/i
          .exec(statement)
      if (match !== null) {
        const table = unquote(match[2])
        const selectedColumns = match[1].trim() === "*"
          ? this.columns.get(table) ?? []
          : match[1].split(",").map((column) => unquote(column.trim()))
        let rows = [...(this.tables.get(table) ?? [])]
        if (match[3] !== undefined) {
          const column = unquote(match[3])
          const value = match[4] === "?" ? params[0] : parseValue(match[4], [], () => 0)
          rows = rows.filter((row) => row[column] === value)
        }
        if (match[6] !== undefined) {
          const column = unquote(match[6])
          rows.sort((a, b) => Number(b[column]) - Number(a[column]))
        }
        return new FakeCursor(rows, selectedColumns)
      }
    }

    return new FakeCursor([])
  }
}

class FakeDurableObjectStorage {
  readonly sql = new FakeSqlStorage()
  transactionCalls = 0
  rollbackCalls = 0

  transaction<T>(body: (txn: { rollback: () => void }) => Promise<T>): Promise<T> {
    this.transactionCalls++
    const snapshot = this.sql.snapshot()
    let rolledBack = false
    const txn = {
      rollback: () => {
        this.rollbackCalls++
        rolledBack = true
      }
    }
    return Promise.resolve().then(() => body(txn)).then(
      (value) => {
        if (rolledBack) {
          this.sql.restore(snapshot)
        }
        return value
      },
      (error) => {
        this.sql.restore(snapshot)
        throw error
      }
    )
  }
}

const normalizeSql = (sql: string) => sql.replace(/;$/, "").replace(/\s+/g, " ").trim()

const unquote = (value: string) => value.replace(/^"|"$/g, "")

const valueGroups = (values: string): Array<string> =>
  values.match(/\(([^)]*)\)/g)?.map((group) => group.slice(1, -1)) ?? []

const parseValue = (
  value: string,
  params: ReadonlyArray<unknown>,
  nextParamIndex: () => number
): unknown => {
  if (value === "?") {
    return params[nextParamIndex()]
  }
  if (/^'.*'$/.test(value)) {
    return value.slice(1, -1)
  }
  const number = Number(value)
  return Number.isNaN(number) ? value : number
}

const makeClient = (config: SqliteClient.SqliteClientConfig) =>
  SqliteClient.make(config).pipe(
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  )

const hasForbiddenTransactionSql = (db: FakeSqlStorage) =>
  db.statements.some((statement) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(normalizeSql(statement)))

describe("Client", () => {
  it.effect("classifies native errors without stable sqlite codes as UnknownError", () =>
    Effect.gen(function*() {
      const failingDb = {
        exec: () => {
          throw new Error("boom")
        }
      } as unknown as SqlStorage

      const client = yield* makeClient({ db: failingDb })
      const error = yield* Effect.flip(client`SELECT 1`)
      assert.strictEqual(error.reason._tag, "UnknownError")
    }))

  it.effect("db-only clients support normal queries", () =>
    Effect.gen(function*() {
      const db = new FakeSqlStorage()
      const sql = yield* makeClient({ db: db as unknown as SqlStorage })

      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      yield* sql`INSERT INTO test (name) VALUES (${"hello"})`
      const rows = yield* sql`SELECT * FROM test`

      assert.deepStrictEqual(rows, [{ id: 1, name: "hello" }])
    }))

  it.effect("db-only transactions fail clearly without transaction SQL", () =>
    Effect.gen(function*() {
      const db = new FakeSqlStorage()
      const sql = yield* makeClient({ db: db as unknown as SqlStorage })

      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      const error = yield* Effect.flip(sql.withTransaction(sql`INSERT INTO test (name) VALUES ('hello')`))
      const rows = yield* sql`SELECT * FROM test`

      assert.strictEqual(error.reason._tag, "UnknownError")
      assert.match(error.message, /Transactions require Durable Object storage/)
      assert.deepStrictEqual(rows, [])
      assert.strictEqual(hasForbiddenTransactionSql(db), false)
    }))

  it.effect("storage-backed transactions use DurableObjectStorage.transaction", () =>
    Effect.gen(function*() {
      const storage = new FakeDurableObjectStorage()
      const sql = yield* makeClient({ storage: storage as unknown as DurableObjectStorage })

      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      yield* sql.withTransaction(sql`INSERT INTO test (name) VALUES ('hello')`)
      const rows = yield* sql`SELECT * FROM test`

      assert.strictEqual(storage.transactionCalls, 1)
      assert.deepStrictEqual(rows, [{ id: 1, name: "hello" }])
      assert.strictEqual(hasForbiddenTransactionSql(storage.sql), false)
    }))

  it.effect("storage-backed failed transactions roll back and re-emit the original failure", () =>
    Effect.gen(function*() {
      const storage = new FakeDurableObjectStorage()
      const sql = yield* makeClient({ storage: storage as unknown as DurableObjectStorage })

      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      const error = yield* sql`INSERT INTO test (name) VALUES ('hello')`.pipe(
        Effect.andThen(Effect.fail("boom")),
        sql.withTransaction,
        Effect.flip
      )
      const rows = yield* sql`SELECT * FROM test`

      assert.strictEqual(error, "boom")
      assert.deepStrictEqual(rows, [])
      assert.strictEqual(storage.rollbackCalls, 1)
    }))

  it.effect("storage-backed interrupted transactions roll back before release", () =>
    Effect.gen(function*() {
      const storage = new FakeDurableObjectStorage()
      const sql = yield* makeClient({ storage: storage as unknown as DurableObjectStorage })
      const inserted = yield* Deferred.make<void>()

      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      const fiber = yield* sql`INSERT INTO test (name) VALUES ('hello')`.pipe(
        Effect.tap(() => Deferred.succeed(inserted, void 0)),
        Effect.andThen(Effect.never),
        sql.withTransaction,
        Effect.forkChild
      )
      yield* Deferred.await(inserted)
      yield* Fiber.interrupt(fiber)
      const rows = yield* sql`SELECT * FROM test`

      assert.deepStrictEqual(rows, [])
      assert.strictEqual(storage.rollbackCalls, 1)
    }))

  it.effect("nested transactions fail clearly without savepoint SQL", () =>
    Effect.gen(function*() {
      const storage = new FakeDurableObjectStorage()
      const sql = yield* makeClient({ storage: storage as unknown as DurableObjectStorage })

      yield* sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`
      const error = yield* sql.withTransaction(
        Effect.gen(function*() {
          yield* sql`INSERT INTO test (name) VALUES ('outer')`
          yield* sql.withTransaction(sql`INSERT INTO test (name) VALUES ('inner')`)
        })
      ).pipe(Effect.flip)
      const rows = yield* sql`SELECT * FROM test`

      assert.strictEqual(error.reason._tag, "UnknownError")
      assert.match(error.message, /Nested transactions are not supported/)
      assert.deepStrictEqual(rows, [])
      assert.strictEqual(storage.rollbackCalls, 1)
      assert.strictEqual(hasForbiddenTransactionSql(storage.sql), false)
    }))

  it.effect("SqliteMigrator.run works with storage-backed transactions", () =>
    Effect.gen(function*() {
      const storage = new FakeDurableObjectStorage()
      const sql = yield* makeClient({ storage: storage as unknown as DurableObjectStorage })

      const completed = yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "1_create": Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE migrated (id INTEGER PRIMARY KEY, name TEXT)`
            yield* sql`INSERT INTO migrated (name) VALUES ('ok')`
          })
        })
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      const rows = yield* sql`SELECT * FROM migrated`
      const migrations = yield* sql`SELECT * FROM effect_sql_migrations`

      assert.deepStrictEqual(completed, [[1, "create"]])
      assert.deepStrictEqual(rows, [{ id: 1, name: "ok" }])
      assert.deepStrictEqual(migrations, [{ migration_id: 1, name: "create", created_at: "current_timestamp" }])
      assert.strictEqual(storage.transactionCalls, 1)
      assert.strictEqual(hasForbiddenTransactionSql(storage.sql), false)
    }))
})
