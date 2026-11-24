import { PgClient } from "@effect/sql-pg"
import { Config, Context, Effect, Layer, type Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { SqlClient, type SqlError } from "effect/sql"
import { describe, expect, it } from "tstyche"

class Prefix extends Context.Service<Prefix, string>()("Prefix") {}

const onAcquire = Effect.andThen(Effect.service(Reactivity.Reactivity), Effect.service(Prefix)).pipe(Effect.asVoid)

describe("PgClient onAcquire", () => {
  it("propagates the hook's requirements, except those the layers supply", () => {
    expect(PgClient.make({ onAcquire })).type.toBe<
      Effect.Effect<
        PgClient.PgClient & SqlClient.SqlClient,
        SqlError.SqlError,
        Scope.Scope | Reactivity.Reactivity | Prefix
      >
    >()
    expect(PgClient.layer({ onAcquire })).type.toBe<
      Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, SqlError.SqlError, Prefix>
    >()
    expect(PgClient.layerConfig({ onAcquire: Config.succeed(onAcquire) })).type.toBe<
      Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, Config.ConfigError | SqlError.SqlError, Prefix>
    >()
  })
})

const program = Effect.service(PgClient.PgClient).pipe(Effect.asVoid)
const sqlClient = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

describe("PgClient", () => {
  it("is not provided by a SqlClient layer", () => {
    expect(Effect.provide(program, sqlClient)).type.toBe<Effect.Effect<void, never, PgClient.PgClient>>()
    expect(Layer.provide(Layer.effectDiscard(program), sqlClient)).type.toBe<
      Layer.Layer<never, never, PgClient.PgClient>
    >()
  })

  it("yields a client that is also a SqlClient", () => {
    expect(Effect.service(PgClient.PgClient)).type.toBeAssignableTo<
      Effect.Effect<PgClient.PgClient & SqlClient.SqlClient, never, PgClient.PgClient>
    >()
  })

  it("rejects incorrect requirement annotations", () => {
    expect<Effect.Effect<void, never, SqlClient.SqlClient>>().type.not.toBeAssignableFrom(program)
    expect<Effect.Effect<void, never, PgClient.PgClient>>().type.not.toBeAssignableFrom(
      Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid)
    )
  })
})
