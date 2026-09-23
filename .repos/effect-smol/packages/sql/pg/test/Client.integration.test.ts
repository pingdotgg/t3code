import { PgClient } from "@effect/sql-pg"
import { assert, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Stream, String } from "effect"
import { TestClock } from "effect/testing"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { SqlClient } from "effect/unstable/sql"
import * as Statement from "effect/unstable/sql/Statement"
import { PgContainer } from "./utils.ts"

const compilerTransform = PgClient.makeCompiler(String.camelToSnake)
const transformsNested = Statement.defaultTransforms(String.snakeToCamel)
const transforms = Statement.defaultTransforms(String.snakeToCamel, false)

it.layer(PgContainer.layerClient, { timeout: "30 seconds" })("PgClient", (it) => {
  it.effect("insert helper", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query, params] = sql`INSERT INTO people ${sql.insert({ name: "Tim", age: 10 })}`.compile()
      expect(query).toEqual(`INSERT INTO people ("name","age") VALUES ($1,$2)`)
      expect(params).toEqual(["Tim", 10])
    }))

  it.effect("updateValues helper", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query, params] = sql`UPDATE people SET name = data.name FROM ${
        sql.updateValues(
          [{ name: "Tim" }, { name: "John" }],
          "data"
        )
      }`.compile()
      expect(query).toEqual(
        `UPDATE people SET name = data.name FROM (values ($1),($2)) AS data("name")`
      )
      expect(params).toEqual(["Tim", "John"])
    }))

  it.effect("updateValues helper returning", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query, params] = sql`UPDATE people SET name = data.name FROM ${
        sql.updateValues(
          [{ name: "Tim" }, { name: "John" }],
          "data"
        ).returning("*")
      }`.compile()
      expect(query).toEqual(
        `UPDATE people SET name = data.name FROM (values ($1),($2)) AS data("name") RETURNING *`
      )
      expect(params).toEqual(["Tim", "John"])
    }))

  it.effect("update helper", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      let result = sql`UPDATE people SET ${sql.update({ name: "Tim" })}`.compile()
      expect(result[0]).toEqual(`UPDATE people SET "name" = $1`)
      expect(result[1]).toEqual(["Tim"])

      result = sql`UPDATE people SET ${sql.update({ name: "Tim", age: 10 }, ["age"])}`.compile()
      expect(result[0]).toEqual(`UPDATE people SET "name" = $1`)
      expect(result[1]).toEqual(["Tim"])
    }))

  it.effect("update helper returning", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const result = sql`UPDATE people SET ${sql.update({ name: "Tim" }).returning("*")}`.compile()
      expect(result[0]).toEqual(`UPDATE people SET "name" = $1 RETURNING *`)
      expect(result[1]).toEqual(["Tim"])
    }))

  it.effect("array helper", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query, params] = sql`SELECT * FROM ${sql("people")} WHERE id IN ${sql.in([1, 2, "string"])}`.compile()
      expect(query).toEqual(`SELECT * FROM "people" WHERE id IN ($1,$2,$3)`)
      expect(params).toEqual([1, 2, "string"])
    }))

  it.effect("array helper with column", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      let result = sql`SELECT * FROM ${sql("people")} WHERE ${sql.in("id", [1, 2, "string"])}`.compile()
      expect(result[0]).toEqual(`SELECT * FROM "people" WHERE "id" IN ($1,$2,$3)`)
      expect(result[1]).toEqual([1, 2, "string"])

      result = sql`SELECT * FROM ${sql("people")} WHERE ${sql.in("id", [])}`.compile()
      expect(result[0]).toEqual(`SELECT * FROM "people" WHERE 1=0`)
      expect(result[1]).toEqual([])
    }))

  it.effect("and", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const now = new Date()
      const result = sql`SELECT * FROM ${sql("people")} WHERE ${
        sql.and([
          sql.in("name", ["Tim", "John"]),
          sql`created_at < ${now}`
        ])
      }`.compile()
      expect(result[0]).toEqual(`SELECT * FROM "people" WHERE ("name" IN ($1,$2) AND created_at < $3)`)
      expect(result[1]).toEqual(["Tim", "John", now])
    }))

  it("transform nested", () => {
    assert.deepEqual(
      transformsNested.array([
        {
          a_key: 1,
          nested: [{ b_key: 2 }],
          arr_primitive: [1, "2", true]
        }
      ]) as any,
      [
        {
          aKey: 1,
          nested: [{ bKey: 2 }],
          arrPrimitive: [1, "2", true]
        }
      ]
    )
  })

  it("transform non nested", () => {
    assert.deepEqual(
      transforms.array([
        {
          a_key: 1,
          nested: [{ b_key: 2 }],
          arr_primitive: [1, "2", true]
        }
      ]) as any,
      [
        {
          aKey: 1,
          nested: [{ b_key: 2 }],
          arrPrimitive: [1, "2", true]
        }
      ]
    )

    assert.deepEqual(
      transforms.array([
        {
          json_field: {
            test_value: [1, true, null, "text"],
            test_nested: {
              test_value: [1, true, null, "text"]
            }
          }
        }
      ]) as any,
      [
        {
          jsonField: {
            test_value: [1, true, null, "text"],
            test_nested: {
              test_value: [1, true, null, "text"]
            }
          }
        }
      ]
    )
  })

  it.effect("insert fragments", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query, params] = sql`INSERT INTO people ${
        sql.insert({
          name: "Tim",
          age: 10,
          json: sql.json({ a: 1 })
        })
      }`.compile()
      assert.strictEqual(
        query,
        "INSERT INTO people (\"name\",\"age\",\"json\") VALUES ($1,$2,$3)"
      )
      assert.lengthOf(params, 3)
    }))

  it.effect("update fragments", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const now = new Date()
      const [query, params] = sql`UPDATE people SET json = data.json FROM ${
        sql.updateValues(
          [{ json: sql.json({ a: 1 }) }, { json: sql.json({ b: 1 }) }],
          "data"
        )
      } WHERE created_at > ${now}`.compile()
      assert.strictEqual(
        query,
        `UPDATE people SET json = data.json FROM (values ($1),($2)) AS data("json") WHERE created_at > $3`
      )
      assert.lengthOf(params, 3)
    }))

  it.effect("onDialect", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      assert.strictEqual(
        sql.onDialect({
          sqlite: () => "A",
          pg: () => "B",
          mysql: () => "C",
          mssql: () => "D",
          clickhouse: () => "E"
        }),
        "B"
      )
      assert.strictEqual(
        sql.onDialectOrElse({
          orElse: () => "A",
          pg: () => "B"
        }),
        "B"
      )
    }))

  it.effect("identifier transform", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query] = compilerTransform.compile(
        sql`SELECT * from ${sql("peopleTest")}`,
        false
      )
      expect(query).toEqual(`SELECT * from "people_test"`)
    }))

  it.effect("jsonb", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const rows = yield* sql<{ json: unknown }>`select ${sql.json({ testValue: 123 })}::jsonb as json`
      expect(rows[0].json).toEqual({ testValue: 123 })
    }))

  it.effect("stream", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT generate_series(1, 3)`.stream.pipe(
        Stream.runCollect
      )
      expect(rows).toEqual([
        { "generate_series": 1 },
        { "generate_series": 2 },
        { "generate_series": 3 }
      ])
    }))

  it.effect("preserves successful concurrent nested transactions", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const firstStarted = yield* Deferred.make<void>()
      const firstInserted = yield* Deferred.make<void>()

      const rows = yield* sql.withTransaction(
        Effect.gen(function*() {
          yield* sql`CREATE TEMP TABLE nested_transactions (value TEXT) ON COMMIT DROP`
          yield* Effect.all([
            sql.withTransaction(
              Effect.gen(function*() {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Effect.sleep("100 millis")
                yield* sql`INSERT INTO nested_transactions VALUES ('first')`
                yield* Deferred.succeed(firstInserted, undefined)
              })
            ),
            Deferred.await(firstStarted).pipe(
              Effect.andThen(sql.withTransaction(
                Deferred.await(firstInserted).pipe(
                  Effect.andThen(Effect.fail("rollback"))
                )
              ))
            )
          ], { concurrency: "unbounded" }).pipe(Effect.catch(() => Effect.void))
          return yield* sql<{ value: string }>`SELECT value FROM nested_transactions`
        })
      )

      assert.deepStrictEqual(rows, [{ value: "first" }])
    }).pipe(TestClock.withLive))
})

it.layer(PgContainer.layerMakeClient, { timeout: "30 seconds" })("PgClient.makeClient", (it) => {
  it.effect("connects before executing queries", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const rows = yield* sql<{ value: number }>`SELECT 1 AS value`
      assert.deepStrictEqual(rows, [{ value: 1 }])
    }))

  it.effect("skips prepared statements for unprepared executions only", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const rows = sql<{ unprepared_row: number }>`SELECT ${1}::int4 AS unprepared_row`
      const values = sql`SELECT ${2}::int4 AS unprepared_values`
      const preparedStatements = sql<{ statement: string }>`
        SELECT statement FROM pg_prepared_statements
        WHERE statement IN (
          'SELECT $1::int4 AS unprepared_row',
          'SELECT $1::int4 AS unprepared_values'
        )
        ORDER BY statement
      `

      assert.deepStrictEqual(yield* rows.unprepared, [{ unprepared_row: 1 }])
      assert.deepStrictEqual(yield* values.valuesUnprepared, [[2]])
      assert.deepStrictEqual(yield* preparedStatements, [])

      assert.deepStrictEqual(yield* rows, [{ unprepared_row: 1 }])
      assert.deepStrictEqual(yield* values.values, [[2]])
      assert.deepStrictEqual(yield* preparedStatements, [
        { statement: "SELECT $1::int4 AS unprepared_row" },
        { statement: "SELECT $1::int4 AS unprepared_values" }
      ])
    }))

  it.effect("pins the primary connection for streams by default", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const streamStarted = yield* Deferred.make<void>()
      const releaseStream = yield* Deferred.make<void>()
      const streamFiber = yield* sql<{ value: number }>`SELECT generate_series(1, 2) AS value`.stream.pipe(
        Stream.tap(() =>
          Effect.andThen(
            Deferred.succeed(streamStarted, undefined),
            Deferred.await(releaseStream)
          )
        ),
        Stream.runCollect,
        Effect.forkScoped
      )

      yield* Deferred.await(streamStarted)
      const rows = yield* sql<{ value: number }>`SELECT 1 AS value`.pipe(
        Effect.timeoutOption("100 millis")
      )
      yield* Deferred.succeed(releaseStream, undefined)
      yield* Fiber.join(streamFiber)

      assert.isTrue(Option.isNone(rows))
    }).pipe(TestClock.withLive))

  it.effect("serializes transactions on its single connection", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const firstBodyStarted = yield* Deferred.make<void>()
      const releaseFirstBody = yield* Deferred.make<void>()
      const secondBodyStarted = yield* Deferred.make<void>()

      const first = yield* sql.withTransaction(Effect.gen(function*() {
        yield* Deferred.succeed(firstBodyStarted, undefined)
        yield* Deferred.await(releaseFirstBody)
      })).pipe(Effect.forkScoped)
      yield* Deferred.await(firstBodyStarted)
      const second = yield* sql.withTransaction(
        Deferred.succeed(secondBodyStarted, undefined)
      ).pipe(Effect.forkScoped)

      const overlap = yield* Deferred.await(secondBodyStarted).pipe(
        Effect.timeoutOption("100 millis"),
        TestClock.withLive
      )
      yield* Deferred.succeed(releaseFirstBody, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      assert.isTrue(Option.isNone(overlap))
    }))
})

it.layer(PgContainer.layerMakeClientAcquireForStream, { timeout: "30 seconds" })(
  "PgClient.makeClient acquireForStream",
  (it) => {
    it.effect("runs queries while a stream is active", () =>
      Effect.gen(function*() {
        const sql = yield* PgClient.PgClient
        const streamStarted = yield* Deferred.make<void>()
        const releaseStream = yield* Deferred.make<void>()
        const streamFiber = yield* sql<{ value: number }>`SELECT generate_series(1, 2) AS value`.stream.pipe(
          Stream.tap(() =>
            Effect.andThen(
              Deferred.succeed(streamStarted, undefined),
              Deferred.await(releaseStream)
            )
          ),
          Stream.runCollect,
          Effect.forkScoped
        )

        yield* Deferred.await(streamStarted)
        const rows = yield* sql<{ value: number }>`SELECT 1 AS value`.pipe(
          Effect.timeoutOrElse({
            duration: "3 seconds",
            orElse: () => Effect.fail(new Error("query timed out while stream was active"))
          })
        )
        yield* Deferred.succeed(releaseStream, undefined)
        yield* Fiber.join(streamFiber)

        assert.deepStrictEqual(rows, [{ value: 1 }])
      }).pipe(TestClock.withLive))

    it.effect("uses a new session for streams", () =>
      Effect.gen(function*() {
        const sql = yield* PgClient.PgClient
        yield* sql`SET application_name = 'sticky-primary'`

        const rows = yield* sql<{ applicationName: string }>`
          SELECT current_setting('application_name') AS "applicationName"
        `.stream.pipe(Stream.runCollect)

        assert.deepStrictEqual(Array.from(rows), [{ applicationName: "side-default" }])
      }))
  }
)

it.effect("PgClient.makeClient surfaces transport creation failures", () =>
  Effect.gen(function*() {
    const error = yield* Effect.flip(PgClient.makeClient({
      username: "test",
      stream: () => {
        throw new Error("connection failed")
      }
    }))

    assert.strictEqual(error.reason._tag, "ConnectionError")
    assert.strictEqual(error.reason.operation, "connect")
  }).pipe(
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  ))

it.layer(PgContainer.layerClientWithTransforms, { timeout: "30 seconds" })("PgClient transforms", (it) => {
  it.effect("insert helper", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const [query, params] = sql`INSERT INTO people ${sql.insert({ firstName: "Tim", age: 10 })}`.compile()
      expect(query).toEqual(`INSERT INTO people ("first_name","age") VALUES ($1,$2)`)
      expect(params).toEqual(["Tim", 10])
    }))

  it.effect("insert helper withoutTransforms", () =>
    Effect.gen(function*() {
      const sql = (yield* PgClient.PgClient).withoutTransforms()
      const [query, params] = sql`INSERT INTO people ${sql.insert({ first_name: "Tim", age: 10 })}`.compile()
      expect(query).toEqual(`INSERT INTO people ("first_name","age") VALUES ($1,$2)`)
      expect(params).toEqual(["Tim", 10])
    }))

  it.effect("rejects multi-statement queries", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const error = yield* Effect.flip(sql`
        CREATE TABLE test_multi (id TEXT PRIMARY KEY, name TEXT);
        SELECT 1;
      `)

      assert.strictEqual(error.reason._tag, "SqlSyntaxError")
    }))

  it.effect("interruption", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const conn = yield* sql.reserve
      yield* conn.executeRaw("select pg_sleep(1000)", []).pipe(
        Effect.timeoutOption("50 millis"),
        TestClock.withLive
      )
      const value = yield* conn.executeValues("select 1", [])
      expect(value).toEqual([[1]])
    }))

  it.effect("retains the supplied config", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient

      assert.isDefined(sql.config.url)
      expect(sql.config.transformResultNames).toEqual(String.snakeToCamel)
      expect(sql.config.transformQueryNames).toEqual(String.camelToSnake)
    }))
})

// Each listener uses one of two pool connections.
it.layer(PgContainer.layerClientForListen, { timeout: "30 seconds", concurrent: false })("PgClient listen", (it) => {
  it.effect("keeps queries available while a listener reserves one connection", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const channel = "pool_connection_listen"

      const payloads = yield* sql.listen(channel)

      const rows = yield* sql<{ value: number }>`SELECT 1 as value`.pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new Error("query timed out while listener was active"))
        })
      )
      expect(rows).toEqual([{ value: 1 }])

      yield* sql.notify(channel, "payload")
      const payload = yield* Queue.take(payloads).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new Error("listener did not receive notification in time"))
        })
      )
      expect(payload.payload).toEqual("payload")
    }).pipe(TestClock.withLive), { timeout: 20_000 })

  it.effect("notify sends payload", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const channel = "pool_connection_notify"

      const payloads = yield* sql.listen(channel)
      yield* sql.notify(channel, "payload")

      const payload = yield* Queue.take(payloads).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new Error("listener did not receive notification in time"))
        })
      )
      expect(payload.payload).toEqual("payload")
    }).pipe(TestClock.withLive), { timeout: 20_000 })

  it.effect("listen rejects channel names longer than 63 UTF-8 bytes", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const error = yield* Effect.flip(sql.listen("é".repeat(32)))

      assert.strictEqual(error.message, "PostgreSQL channel names must not exceed 63 UTF-8 bytes")
      assert.strictEqual(error.reason.operation, "listen")
    }))

  it.effect("notify rejects channel names longer than 63 UTF-8 bytes", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const error = yield* Effect.flip(sql.notify("é".repeat(32), "payload"))

      assert.strictEqual(error.message, "PostgreSQL channel names must not exceed 63 UTF-8 bytes")
      assert.strictEqual(error.reason.operation, "notify")
    }))
})
