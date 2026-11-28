import { D1Client } from "@effect/sql-d1"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(D1Client.D1Client).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("D1Client", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, D1Client.D1Client>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, D1Client.D1Client>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(D1Client.D1Client)).type.toBeAssignableTo<
      Effect.Effect<D1Client.D1Client & SqlClient.SqlClient, never, D1Client.D1Client>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, D1Client.D1Client>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
