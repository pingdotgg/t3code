import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(PgliteClient.PgliteClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("PgliteClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, PgliteClient.PgliteClient>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, PgliteClient.PgliteClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(PgliteClient.PgliteClient)).type.toBeAssignableTo<
      Effect.Effect<PgliteClient.PgliteClient & SqlClient.SqlClient, never, PgliteClient.PgliteClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, PgliteClient.PgliteClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
