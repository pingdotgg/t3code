import { MysqlClient } from "@effect/sql-mysql2"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(MysqlClient.MysqlClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("MysqlClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, MysqlClient.MysqlClient>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, MysqlClient.MysqlClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(MysqlClient.MysqlClient)).type.toBeAssignableTo<
      Effect.Effect<MysqlClient.MysqlClient & SqlClient.SqlClient, never, MysqlClient.MysqlClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, MysqlClient.MysqlClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
