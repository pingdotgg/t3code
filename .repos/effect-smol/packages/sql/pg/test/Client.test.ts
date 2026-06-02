import { PgClient } from "@effect/sql-pg"
import { assert, expect, it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Stream, String } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql"
import * as Statement from "effect/unstable/sql/Statement"
import { parse as parsePgConnectionString } from "pg-connection-string"
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
      const rows = yield* sql<{ json: unknown }>`select ${{ testValue: 123 }}::jsonb as json`
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
})

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

  it.effect("multi-statement queries", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const result = yield* sql<{ id: string; name: string }>`
        CREATE TABLE test_multi (id TEXT PRIMARY KEY, name TEXT);
        INSERT INTO test_multi (id, name) VALUES ('id1', 'test1') RETURNING *;
        INSERT INTO test_multi (id, name) VALUES ('id2', 'test2') RETURNING *;
      `

      expect(result).toHaveLength(3)
      expect(result[0]).toEqual([])
      expect(result[1]).toEqual([{ id: "id1", name: "test1" }])
      expect(result[2]).toEqual([{ id: "id2", name: "test2" }])
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

  it.effect("Should populate config", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient

      assert.isDefined(sql.config.url)

      const parsedConfig = parsePgConnectionString(Redacted.value(sql.config.url))

      expect(sql.config.host).toEqual(parsedConfig.host)
      assert.isNotNull(parsedConfig.port)
      assert.isDefined(parsedConfig.port)
      expect(sql.config.port).toEqual(parseInt(parsedConfig.port))
      expect(sql.config.username).toEqual(parsedConfig.user)
      assert.isDefined(sql.config.password)
      expect(Redacted.value(sql.config.password)).toEqual(parsedConfig.password)
      expect(sql.config.database).toEqual(parsedConfig.database)
    }))
})

it.layer(PgContainer.layerClientSingleConnection, { timeout: "30 seconds" })("PgClient listen", (it) => {
  it.effect("listen does not reserve a pool connection", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const channel = "pool_connection_listen"

      const listenFiber = yield* sql.listen(channel).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped
      )

      yield* Effect.sleep("250 millis")

      const rows = yield* sql<{ value: number }>`SELECT 1 as value`.pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new Error("query timed out while listener was active"))
        })
      )
      expect(rows).toEqual([{ value: 1 }])

      yield* sql.notify(channel, "payload")
      const payloads = yield* Fiber.join(listenFiber).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new Error("listener did not receive notification in time"))
        })
      )
      expect(Array.from(payloads)).toEqual(["payload"])
    }).pipe(TestClock.withLive), 20_000)

  it.effect("notify sends payload", () =>
    Effect.gen(function*() {
      const sql = yield* PgClient.PgClient
      const channel = "pool_connection_notify"

      const listenFiber = yield* sql.listen(channel).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped
      )

      yield* Effect.sleep("250 millis")
      yield* sql.notify(channel, "payload")

      const payloads = yield* Fiber.join(listenFiber).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new Error("listener did not receive notification in time"))
        })
      )
      expect(Array.from(payloads)).toEqual(["payload"])
    }).pipe(TestClock.withLive), 20_000)
})
