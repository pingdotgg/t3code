import { MssqlClient, Procedure } from "@effect/sql-mssql"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Statement from "effect/unstable/sql/Statement"
import type * as Tedious from "tedious"
import { vi } from "vitest"

const state = vi.hoisted(() => ({ cancelCalls: 0, completeRequests: true, type: {} }))

vi.mock("tedious", async (importOriginal) => {
  const original = await importOriginal<typeof Tedious>()

  class MockRequest {
    readonly listeners: Record<string, (...args: Array<any>) => void> = {}

    constructor(
      readonly sql: string,
      readonly callback: (cause: unknown, rowCount: number, rows: ReadonlyArray<any>) => void
    ) {}

    addParameter() {}
    addOutputParameter() {}
    on(event: string, listener: (...args: Array<any>) => void) {
      this.listeners[event] = listener
    }
  }

  class MockConnection {
    connect(callback: (cause: unknown) => void) {
      callback(null)
    }
    close() {}
    on() {}
    cancel() {
      state.cancelCalls++
    }
    execSql(request: MockRequest) {
      if (state.completeRequests) {
        request.callback(null, 0, [])
      }
    }
    callProcedure(request: MockRequest) {
      request.listeners.returnValue("answer", 42)
      request.callback(null, 0, [])
    }
    beginTransaction(callback: (cause: unknown) => void) {
      callback(null)
    }
    commitTransaction(callback: (cause: unknown) => void) {
      callback(null)
    }
    saveTransaction(callback: (cause: unknown) => void) {
      callback(null)
    }
    rollbackTransaction(callback: (cause: unknown) => void) {
      callback(null)
    }
  }

  return {
    ...original,
    Connection: MockConnection,
    Request: MockRequest
  }
})

const sql = Statement.make(Effect.void as any, MssqlClient.makeCompiler(), [], undefined)

describe("mssql", () => {
  it("preserves fractional JavaScript numbers with the default parameter mapping", () => {
    const value = MssqlClient.defaultParameterTypes.number.validate(1.5, undefined)

    expect(value).toBe(1.5)
  })

  it("preserves Unicode JavaScript strings with the default parameter mapping", () => {
    const value = MssqlClient.defaultParameterTypes.string.validate("lambda: \u03bb", undefined)

    expect(value).toBe("lambda: \u03bb")
  })

  it("insert helper", () => {
    const [query, params] = sql`INSERT INTO ${sql("people")} ${sql.insert({ name: "Tim", age: 10 })}`.compile()
    expect(query).toEqual(
      `INSERT INTO [people] ([name],[age]) VALUES (@1,@2)`
    )
    expect(params).toEqual(["Tim", 10])
  })

  it("insert helper returning", () => {
    const [query, params] = sql`INSERT INTO ${sql("people")} ${sql.insert({ name: "Tim", age: 10 }).returning("*")}`
      .compile()
    expect(query).toEqual(
      `INSERT INTO [people] ([name],[age]) OUTPUT INSERTED.* VALUES (@1,@2)`
    )
    expect(params).toEqual(["Tim", 10])
  })

  it("update helper", () => {
    const [query, params] = sql`UPDATE people SET name = data.name ${
      sql.updateValues(
        [{ name: "Tim" }, { name: "John" }],
        "data"
      )
    }`.compile()
    expect(query).toEqual(
      `UPDATE people SET name = data.name FROM (values (@1),(@2)) AS data([name])`
    )
    expect(params).toEqual(["Tim", "John"])
  })

  it("update helper returning", () => {
    const [query, params] = sql`UPDATE people SET name = data.name ${
      sql.updateValues(
        [{ name: "Tim" }, { name: "John" }],
        "data"
      ).returning("*")
    }`.compile()
    expect(query).toEqual(
      `UPDATE people SET name = data.name OUTPUT INSERTED.* FROM (values (@1),(@2)) AS data([name])`
    )
    expect(params).toEqual(["Tim", "John"])
  })

  it("update single helper returning", () => {
    const [query, params] = sql`UPDATE people SET ${sql.update({ name: "Tim" }).returning("*")}`
      .compile()
    expect(query).toEqual(
      `UPDATE people SET [name] = @1 OUTPUT INSERTED.*`
    )
    expect(params).toEqual(["Tim"])
  })

  for (
    const [name, returning] of [
      ["Identifier", sql("INSERTED.name")],
      ["wrapped Identifier", sql`${sql("INSERTED.name")}`]
    ] as const
  ) {
    it(`insert helper returning ${name}`, () => {
      const result = sql`INSERT INTO ${sql("people")} ${sql.insert({ name: "Rowan", age: 10 }).returning(returning)}`
        .compile()

      assert.deepStrictEqual(result, [
        `INSERT INTO [people] ([name],[age]) OUTPUT [INSERTED].[name] VALUES (@1,@2)`,
        ["Rowan", 10]
      ])
    })

    it(`update helper returning ${name}`, () => {
      const result = sql`UPDATE people SET ${sql.update({ name: "Rowan" }).returning(returning)}`.compile()

      assert.deepStrictEqual(result, [
        `UPDATE people SET [name] = @1 OUTPUT [INSERTED].[name]`,
        ["Rowan"]
      ])
    })

    it(`updateValues helper returning ${name}`, () => {
      const result = sql`UPDATE people SET name = data.name ${
        sql.updateValues([{ name: "Rowan" }, { name: "Mira" }], "data").returning(returning)
      }`.compile()

      assert.deepStrictEqual(result, [
        `UPDATE people SET name = data.name OUTPUT [INSERTED].[name] FROM (values (@1),(@2)) AS data([name])`,
        ["Rowan", "Mira"]
      ])
    })
  }

  it("array helper", () => {
    const [query, params] = sql`SELECT * FROM ${sql("people")} WHERE id IN ${sql.in([1, 2, "string"])}`.compile()
    expect(query).toEqual(`SELECT * FROM [people] WHERE id IN (@1,@2,@3)`)
    expect(params).toEqual([1, 2, "string"])
  })

  // it("param types", () => {
  //   const [query, params] = sql`SELECT * FROM ${sql("people")} WHERE id = ${
  //     sql.param(
  //       MssqlTypes.BigInt,
  //       1
  //     )
  //   }`.compile()
  //   expect(query).toEqual(`SELECT * FROM [people] WHERE id = @1`)
  //   expect(isCustom("MssqlParam")(params[0])).toEqual(true)
  //   const param = params[0] as unknown as Custom<
  //     "MsSqlParam",
  //     any,
  //     any,
  //     any
  //   >
  //   expect(param.i0).toEqual(MssqlTypes.BigInt)
  //   expect(param.i1).toEqual(1)
  //   expect(param.i2).toEqual({})
  // })

  it("escape [", () => {
    const [query] = sql`SELECT * FROM ${sql("peo[]ple.te[st]ing")}`.compile()
    expect(query).toEqual(`SELECT * FROM [peo[]]ple].[te[st]]ing]`)
  })

  it.effect("returns stored procedure output parameters under output", () =>
    Effect.gen(function*() {
      const client = yield* MssqlClient.make({ server: "localhost" })
      const definition = Procedure.outputParam<number>()("answer", state.type as any)(Procedure.make("get_answer"))
      const result = yield* client.call(Procedure.compile(definition)({}))

      assert.deepStrictEqual(result, { output: { answer: 42 }, rows: [] })
    }).pipe(
      Effect.scoped,
      Effect.provide(Reactivity.layer)
    ))

  it.effect("cancels an in-flight Tedious request when interrupted", () =>
    Effect.gen(function*() {
      state.cancelCalls = 0
      state.completeRequests = true
      const client = yield* MssqlClient.make({ server: "localhost" })
      state.completeRequests = false
      const fiber = yield* Effect.forkChild(client`WAITFOR DELAY '00:01:00'`)
      yield* Effect.yieldNow
      const callsBeforeInterrupt = state.cancelCalls
      yield* Fiber.interrupt(fiber)

      assert.strictEqual(state.cancelCalls, callsBeforeInterrupt + 1)
    }).pipe(
      Effect.scoped,
      Effect.provide(Reactivity.layer)
    ))
})
