import { MssqlClient } from "@effect/sql-mssql"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Statement from "effect/unstable/sql/Statement"

const sql = Statement.make(Effect.void as any, MssqlClient.makeCompiler(), [], undefined)

describe("mssql", () => {
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
})
