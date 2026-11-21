import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(ClickhouseClient.ClickhouseClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("ClickhouseClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<
      Effect.Effect<void, never, ClickhouseClient.ClickhouseClient>
    >()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, ClickhouseClient.ClickhouseClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(ClickhouseClient.ClickhouseClient)).type.toBeAssignableTo<
      Effect.Effect<ClickhouseClient.ClickhouseClient & SqlClient.SqlClient, never, ClickhouseClient.ClickhouseClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, ClickhouseClient.ClickhouseClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
