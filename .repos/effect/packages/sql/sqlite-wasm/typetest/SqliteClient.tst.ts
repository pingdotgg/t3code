import { SqliteClient } from "@effect/sql-sqlite-wasm"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "tstyche"

const program = Effect.service(SqliteClient.SqliteClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("SqliteClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, SqliteClient.SqliteClient>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, SqliteClient.SqliteClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(SqliteClient.SqliteClient)).type.toBeAssignableTo<
      Effect.Effect<SqliteClient.SqliteClient & SqlClient.SqlClient, never, SqliteClient.SqliteClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, SqliteClient.SqliteClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
