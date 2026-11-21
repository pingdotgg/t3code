import { LibsqlClient } from "@effect/sql-libsql"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(LibsqlClient.LibsqlClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("LibsqlClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, LibsqlClient.LibsqlClient>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, LibsqlClient.LibsqlClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(LibsqlClient.LibsqlClient)).type.toBeAssignableTo<
      Effect.Effect<LibsqlClient.LibsqlClient & SqlClient.SqlClient, never, LibsqlClient.LibsqlClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, LibsqlClient.LibsqlClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
