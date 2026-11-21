import { MssqlClient } from "@effect/sql-mssql"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(MssqlClient.MssqlClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("MssqlClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, MssqlClient.MssqlClient>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, MssqlClient.MssqlClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(MssqlClient.MssqlClient)).type.toBeAssignableTo<
      Effect.Effect<MssqlClient.MssqlClient & SqlClient.SqlClient, never, MssqlClient.MssqlClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, MssqlClient.MssqlClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
