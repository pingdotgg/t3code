/**
 * The entity Durable Object's SQLite exposed to entity handlers as
 * `DurableObjectSqlClient`.
 *
 * A user transaction holds `storage.transaction()` open across Effect
 * suspensions, and every write on the object's single SQLite connection lands
 * inside it. Another handler resumed from inside the transaction could save
 * its reply there and lose it to the user's rollback, so mailbox writes wait
 * on the same gate as user transactions.
 *
 * @internal
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as SqlClient from "effect/sql/SqlClient"
import { DurableObjectSqlClient } from "../CloudflareCluster.ts"

/** @internal */
export interface EntitySql {
  /** Builds the client for one handler build, closed with that build's scope. */
  readonly make: Effect.Effect<Context.Context<DurableObjectSqlClient>, never, Scope.Scope>
  /** Runs a mailbox write once no user transaction is open. */
  readonly guard: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const InUserTransaction = Context.Reference<boolean>(
  "@effect/platform-cloudflare/internal/entitySql/InUserTransaction",
  { defaultValue: () => false }
)

/** @internal */
export const makeEntitySql = (storage: DurableObjectStorage): EntitySql => {
  const gate = Semaphore.makeUnsafe(1)

  const make = Effect.map(
    Effect.provideServiceEffect(SqliteClient.make({ storage }), Reactivity.Reactivity, Reactivity.make),
    (client) => {
      // Nested transactions reuse the outer storage transaction, so only the
      // outermost one takes the gate.
      const withTransaction = client.withTransaction
      const gated: SqlClient.SqlClient["withTransaction"] = (effect) =>
        Effect.withFiber((fiber) =>
          fiber.getRef(InUserTransaction)
            ? withTransaction(effect)
            : Semaphore.withPermit(gate, withTransaction(Effect.provideService(effect, InUserTransaction, true)))
        )
      return Context.make(DurableObjectSqlClient, Object.assign(client, { withTransaction: gated }))
    }
  )

  return {
    make,
    guard: (effect) => Semaphore.withPermit(gate, effect)
  }
}
