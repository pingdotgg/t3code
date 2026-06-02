/**
 * Defines the `SqlClient` service, the central runtime entry point for Effect's
 * unstable SQL support.
 *
 * A `SqlClient` combines the tagged-template statement constructor with a
 * scoped connection acquirer, dialect compiler, tracing attributes, optional row
 * transforms, reactive query helpers, and transaction management. Applications
 * typically consume it from `Context` to build parameterized queries, stream
 * rows, run raw driver operations, reserve a connection for lower-level work, or
 * wrap several query effects in `withTransaction`.
 *
 * Transactions are tracked through a per-client context service. Top-level
 * transactions acquire the configured transaction connection and issue the
 * dialect's begin/commit/rollback SQL; nested transactions reuse that
 * connection and rely on dialect-provided savepoint SQL. A query only joins a
 * transaction when it is run with the same client service, so avoid mixing
 * clients or manually reserved connections when atomicity matters. Dialect
 * integrations are also responsible for the compiler and transaction
 * statements, which means placeholder syntax, identifier escaping, row
 * transforms, savepoint support, and unprepared/raw statement behavior can
 * differ by database.
 *
 * @since 4.0.0
 */
import { Clock } from "../../Clock.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import type * as Queue from "../../Queue.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import * as Tracer from "../../Tracer.ts"
import type { NoInfer } from "../../Types.ts"
import { Reactivity } from "../reactivity/Reactivity.ts"
import type * as Connection from "./SqlConnection.ts"
import type { SqlError } from "./SqlError.ts"
import type { Compiler, Constructor } from "./Statement.ts"
import * as Statement from "./Statement.ts"

const TypeId = "~effect/sql/SqlClient"

/**
 * SQL client service interface, combining the statement constructor API with
 * connection reservation, transaction handling, and reactive query helpers.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqlClient extends Constructor {
  readonly [TypeId]: typeof TypeId

  /**
   * Copy of the client for safeql etc.
   */
  readonly safe: this

  /**
   * Copy of the client without transformations.
   */
  readonly withoutTransforms: () => this

  readonly reserve: Effect.Effect<Connection.Connection, SqlError, Scope.Scope>

  /**
   * With the given effect, ensure all sql queries are run in a transaction.
   */
  readonly withTransaction: <R, E, A>(
    self: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError, R>

  /**
   * The transaction service for this client.
   */
  readonly transactionService: Context.Service<TransactionConnection, TransactionConnection.Service>

  /**
   * Use the Reactivity service from @effect/experimental to create a reactive
   * query.
   */
  readonly reactive: <A, E, R>(
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ) => Stream.Stream<A, E, R>

  /**
   * Use the Reactivity service to create a reactive
   * query.
   */
  readonly reactiveMailbox: <A, E, R>(
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>
}

/**
 * Service tag for the active SQL client service.
 *
 * **When to use**
 *
 * Use to access or provide the SQL client used to build statements, stream
 * rows, reserve connections, and run transactions.
 *
 * @category tags
 * @since 4.0.0
 */
export const SqlClient = Context.Service<SqlClient>("effect/sql/SqlClient")

/**
 * Namespace containing types associated with the `SqlClient` service.
 *
 * @since 4.0.0
 */
export declare namespace SqlClient {
  /**
   * Options used to construct a `SqlClient`, including connection acquirers,
   * the SQL compiler, transaction SQL, row transformation, tracing attributes,
   * and optional reactive query integration.
   *
   * @category models
   * @since 4.0.0
   */
  export interface MakeOptions {
    readonly acquirer: Connection.Acquirer
    readonly compiler: Compiler
    readonly transactionAcquirer?: Connection.Acquirer
    readonly spanAttributes: ReadonlyArray<readonly [string, unknown]>
    readonly transactionService?: Context.Service<TransactionConnection, TransactionConnection.Service>
    readonly beginTransaction?: string | undefined
    readonly rollback?: string | undefined
    readonly commit?: string | undefined
    readonly savepoint?: ((name: string) => string) | undefined
    readonly rollbackSavepoint?: ((name: string) => string) | undefined
    readonly transformRows?: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
    readonly reactiveQueue?: <A, E, R>(
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>
  }
}

let clientIdCounter = 0

/**
 * Constructs a `SqlClient` from connection acquirers, a compiler, transaction
 * commands, tracing attributes, optional row transforms, and reactive query
 * integration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(options: SqlClient.MakeOptions) {
  const transactionService = options.transactionService ?? TransactionConnection(clientIdCounter++)
  const getConnection = Effect.flatMap(
    Effect.serviceOption(transactionService),
    Option.match({
      onNone: () => options.acquirer,
      onSome: ([conn]) => Effect.succeed(conn)
    })
  )

  const beginTransaction = options.beginTransaction ?? "BEGIN"
  const commit = options.commit ?? "COMMIT"
  const savepoint = options.savepoint ?? ((name: string) => `SAVEPOINT ${name}`)
  const rollback = options.rollback ?? "ROLLBACK"
  const rollbackSavepoint = options.rollbackSavepoint ?? ((name: string) => `ROLLBACK TO SAVEPOINT ${name}`)
  const transactionAcquirer = options.transactionAcquirer ?? options.acquirer
  const withTransaction = makeWithTransaction({
    transactionService,
    spanAttributes: options.spanAttributes,
    acquireConnection: Effect.flatMap(
      Scope.make(),
      (scope) => Effect.map(Scope.provide(transactionAcquirer!, scope), (conn) => [scope, conn] as const)
    ),
    begin: (conn) => conn.executeUnprepared(beginTransaction, [], undefined),
    savepoint: (conn, id) => conn.executeUnprepared(savepoint(`effect_sql_${id}`), [], undefined),
    commit: (conn) => conn.executeUnprepared(commit, [], undefined),
    rollback: (conn) => conn.executeUnprepared(rollback, [], undefined),
    rollbackSavepoint: (conn, id) => conn.executeUnprepared(rollbackSavepoint(`effect_sql_${id}`), [], undefined)
  })

  const reactivity = yield* Reactivity
  const client: SqlClient = Object.assign(
    Statement.make(getConnection, options.compiler, options.spanAttributes, options.transformRows),
    {
      [TypeId]: TypeId as typeof TypeId,
      safe: undefined as any,
      withTransaction,
      transactionService,
      reserve: transactionAcquirer,
      withoutTransforms(): any {
        if (options.transformRows === undefined) {
          return this
        }
        const statement = Statement.make(
          getConnection,
          options.compiler.withoutTransform,
          options.spanAttributes,
          undefined
        )
        const client = Object.assign(statement, {
          ...this,
          ...statement
        })
        ;(client as any).safe = client
        ;(client as any).withoutTransforms = () => client
        return client
      },
      reactive: options.reactiveQueue ?
        <A, E, R>(
          keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
          effect: Effect.Effect<A, E, R>
        ) =>
          options.reactiveQueue!(keys, effect).pipe(
            Effect.map(Stream.fromQueue),
            Stream.unwrap
          ) :
        reactivity.stream,
      reactiveMailbox: options.reactiveQueue ?? reactivity.query
    }
  )
  ;(client as any).safe = client

  return client
})

/**
 * Builds a transaction wrapper that begins top-level transactions, uses
 * savepoints for nested transactions, commits on success, and rolls back on
 * failure or interruption.
 *
 * @category transactions
 * @since 4.0.0
 */
export const makeWithTransaction = <I, S>(options: {
  readonly transactionService: Context.Key<I, readonly [conn: S, counter: number]>
  readonly spanAttributes: ReadonlyArray<readonly [string, unknown]>
  readonly acquireConnection: Effect.Effect<readonly [Scope.Closeable | undefined, S], SqlError>
  readonly begin: (conn: NoInfer<S>) => Effect.Effect<void, SqlError>
  readonly savepoint: (conn: NoInfer<S>, id: number) => Effect.Effect<void, SqlError>
  readonly commit: (conn: NoInfer<S>) => Effect.Effect<void, SqlError>
  readonly rollback: (conn: NoInfer<S>) => Effect.Effect<void, SqlError>
  readonly rollbackSavepoint: (conn: NoInfer<S>, id: number) => Effect.Effect<void, SqlError>
}) =>
<R, E, A>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> => {
  return Effect.uninterruptibleMask((restore) =>
    Effect.useSpan(
      "sql.transaction",
      { kind: "client" },
      (span) =>
        Effect.withFiber<A, E | SqlError, R>((fiber) => {
          for (const [key, value] of options.spanAttributes) {
            span.attribute(key, value)
          }
          const services = fiber.context
          const clock = fiber.getRef(Clock)
          const connOption = Context.getOption(services, options.transactionService)
          const conn = connOption._tag === "Some"
            ? Effect.succeed([undefined, connOption.value[0]] as const)
            : options.acquireConnection
          const id = connOption._tag === "Some" ? connOption.value[1] + 1 : 0
          return Effect.flatMap(
            conn,
            (
              [scope, conn]
            ) =>
              (id === 0 ? options.begin(conn) : options.savepoint(conn, id)).pipe(
                Effect.flatMap(() =>
                  Effect.provideContext(
                    restore(effect),
                    Context.mutate(services, (services) =>
                      services.pipe(
                        Context.add(options.transactionService, [conn, id]),
                        Context.add(Tracer.ParentSpan, span)
                      ))
                  )
                ),
                Effect.exit,
                Effect.flatMap((exit) => {
                  let effect: Effect.Effect<void>
                  if (Exit.isSuccess(exit)) {
                    if (id === 0) {
                      span.event("db.transaction.commit", clock.currentTimeNanosUnsafe())
                      effect = Effect.orDie(options.commit(conn))
                    } else {
                      span.event("db.transaction.savepoint", clock.currentTimeNanosUnsafe())
                      effect = Effect.void
                    }
                  } else {
                    span.event("db.transaction.rollback", clock.currentTimeNanosUnsafe())
                    effect = Effect.orDie(
                      id > 0
                        ? options.rollbackSavepoint(conn, id)
                        : options.rollback(conn)
                    )
                  }
                  const withScope = scope !== undefined ? Effect.ensuring(effect, Scope.close(scope, exit)) : effect
                  return Effect.flatMap(withScope, () => exit)
                })
              )
          )
        })
    )
  )
}

/**
 * Phantom identifier for the scoped transaction connection service associated
 * with a SQL client.
 *
 * @category models
 * @since 4.0.0
 */
export interface TransactionConnection {
  readonly _: unique symbol
}

/**
 * Namespace containing types associated with transaction connection services.
 *
 * @since 4.0.0
 */
export declare namespace TransactionConnection {
  /**
   * Service payload stored during a transaction, containing the active
   * connection and nested transaction depth.
   *
   * @category services
   * @since 4.0.0
   */
  export type Service = readonly [conn: Connection.Connection, depth: number]
}

/**
 * Creates a unique context service tag for the active transaction connection of
 * a specific SQL client.
 *
 * @category tags
 * @since 4.0.0
 */
export const TransactionConnection = (
  clientId: number
): Context.Service<TransactionConnection, TransactionConnection.Service> =>
  Context.Service(`effect/sql/SqlClient/TransactionConnection/${clientId}`)

/**
 * Context reference used by SQL integrations to opt in to safe integer
 * handling; defaults to `false`.
 *
 * @category references
 * @since 4.0.0
 */
export const SafeIntegers = Context.Reference<boolean>("effect/sql/SqlClient/SafeIntegers", {
  defaultValue: () => false
})
