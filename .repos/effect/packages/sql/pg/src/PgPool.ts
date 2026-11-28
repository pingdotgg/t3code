/**
 * Pools of native `PgConnection` sessions.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Pool from "effect/Pool"
import { TracerTimingEnabled } from "effect/References"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { SpanPropagationEnabled } from "effect/sql/Statement"
import * as Tracer from "effect/Tracer"
import { connectionInternals } from "./internal/connection.ts"
import * as PgConnection from "./PgConnection.ts"

const defaultMultiplexConcurrency = 32

/**
 * The runtime type identifier for `PgPool`.
 *
 * @stability unstable
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-pg/PgPool"

/**
 * The type-level identifier for `PgPool`.
 *
 * @stability unstable
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-pg/PgPool"

/**
 * Connection and sizing settings for a PostgreSQL session pool.
 *
 * **Details**
 *
 * The defaults are 0 to 10 connections and a 60-second idle timeout.
 * `connectionTTL` replaces connections that exceed the configured lifetime.
 * A retired session keeps its `maxConnections` slot until its transport closes.
 * Every connection is used at least once, so a TTL of zero disables reuse.
 * `acquireTimeout` bounds how long a checkout takes to acquire a connection,
 * including opening a new one; by default it waits indefinitely.
 *
 * With `multiplex` enabled, fibers may share pooled connections for pipelined
 * queries. Reserved connections remain exclusive. Without multiplexing, every
 * checkout is exclusive.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Config extends PgConnection.Config {
  readonly idleTimeout?: Duration.Input | undefined
  readonly maxConnections?: number | undefined
  readonly minConnections?: number | undefined
  readonly connectionTTL?: Duration.Input | undefined
  /**
   * How long a checkout may take to acquire a connection before failing with
   * a `ConnectionError`. Acquisition includes waiting for a free connection
   * and opening a new one when the pool needs it. With `multiplex` on,
   * `reserve` also waits for statements already sent on the shared connection
   * to finish, and that wait counts too. Work done with the connection after
   * it is acquired is not bounded. Unbounded by default.
   */
  readonly acquireTimeout?: Duration.Input | undefined
  /**
   * How many statements may share one connection when `multiplex` is on.
   * Defaults to `32`. Statements are pipelined into one write, so a higher
   * number means fewer round trips, but it also means a slow statement holds
   * up more of the statements queued behind it.
   */
  readonly multiplexConcurrency?: number | undefined
}

/**
 * A PostgreSQL session pool.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface PgPool {
  readonly [TypeId]: TypeId
  readonly config: Config
  /**
   * Checks out a session until the scope closes. Without multiplexing the
   * checkout is exclusive. With multiplexing the
   * session may be shared with other fibers, so multi-statement work should
   * use `reserve` instead.
   */
  readonly get: Effect.Effect<PgConnection.PgConnection, SqlError, Scope.Scope>
  /**
   * Checks out a session for exclusive use until the scope closes. Use this for
   * transactions and listeners on a multiplexed pool.
   */
  readonly reserve: Effect.Effect<PgConnection.PgConnection, SqlError, Scope.Scope>
  /**
   * Removes a session so the pool can replace it. Fatal protocol and socket
   * errors invalidate sessions automatically.
   */
  /**
   * Lends a session for the duration of one effect and takes it back on any
   * exit, without opening a scope for it.
   *
   * **Details**
   *
   * For work that finishes with the effect that runs it. A lease that has to
   * outlive its effect - a stream, a transaction - takes `get` or `reserve`.
   */
  readonly use: <A, E, R>(
    f: (connection: PgConnection.PgConnection) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SqlError, R>
  readonly invalidate: (connection: PgConnection.PgConnection) => Effect.Effect<void>
  /**
   * Returns a snapshot of session occupancy. Counts sessions rather than
   * statements, so a multiplexed session shared by many fibers counts once. A
   * session that has just failed can show as idle until the pool removes it.
   */
  readonly stats: Effect.Effect<Pool.Stats>
}

/**
 * The service tag for `PgPool`.
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export const PgPool = Context.Service<PgPool>("@effect/sql-pg/PgPool")

/**
 * Creates a scoped PostgreSQL session pool.
 *
 * **Details**
 *
 * Connections are opened lazily up to `maxConnections` and released down to
 * `minConnections` after `idleTimeout` without use. A retired session stops
 * being handed out immediately, but its slot is held until its transport
 * closes. Closing the scope shuts the pool down and releases every session.
 *
 * With `SpanPropagationEnabled`, a statement that waited for a new session gets
 * a `db.connect` child span covering the part of the connect it waited for.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(options: Config): Effect.fn.Return<PgPool, SqlError, Scope.Scope> {
  const clock = yield* Clock.Clock
  const runFork = Effect.runForkWith(yield* Effect.context())

  const multiplex = options.multiplex ?? false
  const connectionTTL = options.connectionTTL !== undefined
    ? Duration.toMillis(Duration.fromInputUnsafe(options.connectionTTL))
    : undefined
  const acquireTimeout = options.acquireTimeout !== undefined
    ? Duration.fromInputUnsafe(options.acquireTimeout)
    : undefined
  const deadConnections = new Set<PgConnection.PgConnection>()
  const createdAt = new WeakMap<PgConnection.PgConnection, number>()
  const checkedOut = new WeakSet<PgConnection.PgConnection>()

  // The pool opens sessions on its own fiber, where a span would have no
  // statement parent. Each connect is recorded here instead and reported on the
  // session's first checkout, under the statement that waited for it.
  const connects = new WeakMap<PgConnection.PgConnection, readonly [startTime: bigint, endTime: bigint]>()

  const reportConnect = (connection: PgConnection.PgConnection): Effect.Effect<void> =>
    Effect.withFiber((fiber) => {
      const opened = connects.get(connection)
      if (opened === undefined) return Effect.void
      connects.delete(connection)
      const statement = fiber.cache.span
      // Without span timing the statement span has no start time to measure from.
      if (
        !fiber.cache.tracerEnabled || statement?._tag !== "Span" || !fiber.getRef(SpanPropagationEnabled) ||
        !fiber.getRef(TracerTimingEnabled)
      ) {
        return Effect.void
      }
      const [startTime, endTime] = opened
      const waitedFrom = statement.status.startTime
      if (endTime < waitedFrom) return Effect.void
      const span = fiber.getRef(Tracer.Tracer).span({
        name: "db.connect",
        parent: Option.some(statement),
        annotations: Context.empty(),
        links: [],
        startTime: startTime > waitedFrom ? startTime : waitedFrom,
        kind: "client",
        root: false,
        sampled: statement.sampled
      })
      span.attribute("db.system.name", "postgresql")
      span.attribute("db.client.connection.connect_time_ms", Number(endTime - startTime) / 1e6)
      span.end(endTime, Exit.void)
      return Effect.void
    })

  const handOut = (connection: PgConnection.PgConnection) =>
    connects.has(connection) ? Effect.as(reportConnect(connection), connection) : Effect.succeed(connection)

  // Assigned below, once the pool exists. `acquire` only runs when the pool
  // opens a connection, which is always after that.
  let pool: Pool.Pool<PgConnection.PgConnection, SqlError>
  const maxConnections = options.maxConnections ?? 10
  // One permit per open transport. The pool replaces a retired session at
  // once, but the replacement only connects after the old transport closes.
  const transports = Semaphore.makeUnsafe(maxConnections)
  const acquire = Effect.uninterruptibleMask((restore) => {
    // Closed once: on connect failure/interruption or when the transport closes.
    const permit = Scope.makeUnsafe()
    return Effect.onError(
      Effect.flatMap(restore(Scope.provide(transports.takeScoped(1), permit)), () => {
        const startTime = clock.currentTimeNanosUnsafe()
        return Effect.map(restore(PgConnection.make(options)), (connection) => {
          connects.set(connection, [startTime, clock.currentTimeNanosUnsafe()])
          createdAt.set(connection, clock.currentTimeMillisUnsafe())
          const internals = connectionInternals(connection)
          internals.onTransportClose(() => runFork(Scope.close(permit, Exit.void)))
          internals.retireHooks.add(() => {
            deadConnections.add(connection)
            // `deadConnections` is only read by the next checkout, and a checkout
            // already waiting for this connection would never get that far. Tell
            // the pool now so it can replace the connection and admit them.
            runFork(Pool.invalidate(pool, connection))
          })
          // Pinning a shared session has to take it out of circulation, or a
          // second checkout lands on the connection its own stream is holding.
          if (multiplex) internals.reserve = Pool.reserve(pool, connection)
          return connection
        })
      }),
      (cause) => Scope.close(permit, Exit.failCause(cause))
    )
  })

  pool = yield* Pool.makeWithTTL({
    acquire,
    min: options.minConnections ?? 0,
    max: maxConnections,
    concurrency: multiplex
      ? Math.max(1, options.multiplexConcurrency ?? defaultMultiplexConcurrency)
      : 1,
    timeToLive: options.idleTimeout ?? Duration.seconds(60),
    timeToLiveStrategy: "usage"
  })

  const expired = (connection: PgConnection.PgConnection): boolean => {
    if (connectionInternals(connection).deadError() !== undefined) return true
    if (connectionTTL === undefined) return false
    if (!checkedOut.has(connection)) {
      checkedOut.add(connection)
      return false
    }
    const openedAt = createdAt.get(connection)
    return openedAt !== undefined && clock.currentTimeMillisUnsafe() - openedAt >= connectionTTL
  }

  // Runs `f` uninterruptibly in a child scope, closing it on failure or
  // interruption so acquired resources are returned instead of left on the caller.
  const withChildScope = <A>(
    f: (
      scope: Scope.Closeable,
      restore: <X, E, R>(effect: Effect.Effect<X, E, R>) => Effect.Effect<X, E, R>
    ) => Effect.Effect<A, SqlError>
  ): Effect.Effect<A, SqlError, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.withFiber((fiber) => {
        const scope = Scope.forkUnsafe(Context.getUnsafe(fiber.context, Scope.Scope))
        return Effect.onError(f(scope, restore), (cause) => Scope.close(scope, Exit.failCause(cause)))
      })
    )

  // One checkout attempt (`undefined` if rejected). Closes the attempt scope
  // before retrying so the rejected transport frees its slot first.
  const attempt = withChildScope((scope, restore) =>
    Effect.flatMap(restore(Scope.provide(Pool.get(pool), scope)), (connection) =>
      expired(connection)
        ? Effect.andThen(Pool.invalidate(pool, connection), Effect.as(Scope.close(scope, Exit.void), undefined))
        : Effect.succeed(connection))
  )

  const retry: Effect.Effect<PgConnection.PgConnection, SqlError, Scope.Scope> = Effect.gen(function*() {
    while (true) {
      if (deadConnections.size > 0) {
        const dead = Array.from(deadConnections)
        deadConnections.clear()
        yield* Effect.forEach(dead, (connection) => Pool.invalidate(pool, connection), { discard: true })
      }
      const connection = yield* attempt
      if (connection !== undefined) return connection
    }
  })

  // Without a TTL, only dead sessions are rejected so the common path stays a
  // plain flatMap. With a TTL, an expired session's transport may still be
  // open, so every attempt leases into its own scope and a rejected lease is
  // released before the next attempt.
  const first: Effect.Effect<PgConnection.PgConnection, SqlError, Scope.Scope> = connectionTTL !== undefined
    ? Effect.flatMap(attempt, (connection) => connection === undefined ? retry : Effect.succeed(connection))
    : Effect.flatMap(Pool.get(pool), (connection) =>
      expired(connection)
        ? Effect.andThen(Pool.invalidate(pool, connection), retry)
        : Effect.succeed(connection))
  const checkout: Effect.Effect<PgConnection.PgConnection, SqlError, Scope.Scope> = Effect.suspend(() =>
    deadConnections.size > 0 ? retry : first
  )

  const acquireTimedOut = () =>
    Effect.fail(
      new SqlError({
        reason: new ConnectionError({
          cause: new Error("Timed out waiting for a pooled connection"),
          message: "PgPool: Timed out waiting for a pooled connection",
          operation: "acquireConnection"
        })
      })
    )

  const withAcquireTimeout = <A>(
    effect: Effect.Effect<A, SqlError, Scope.Scope>
  ): Effect.Effect<A, SqlError, Scope.Scope> =>
    acquireTimeout === undefined ?
      effect :
      withChildScope((scope, restore) =>
        restore(Effect.timeoutOrElse(Scope.provide(effect, scope), {
          duration: acquireTimeout,
          orElse: acquireTimedOut
        }))
      )

  const rejected: unique symbol = Symbol()
  const handedOut = Effect.flatMap(checkout, handOut)
  const get = withAcquireTimeout(handedOut)

  // `pin` reserves the pool item itself. On a multiplexed pool it also waits
  // for shared statements to drain, so the acquire timeout covers it too.
  const reserve = withAcquireTimeout(Effect.flatMap(handedOut, (connection) => connection.pin))

  // `Pool.use` cannot bound its wait, so it is used only when no acquire
  // timeout applies and no connection awaits retirement.
  const use = <A, E, R>(
    f: (connection: PgConnection.PgConnection) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.suspend(() => {
      if (acquireTimeout !== undefined || deadConnections.size > 0) return Effect.scoped(Effect.flatMap(get, f))
      const run = (connection: PgConnection.PgConnection) =>
        connects.has(connection) ? Effect.andThen(reportConnect(connection), f(connection)) : f(connection)
      if (connectionTTL === undefined) return Pool.use(pool, run)
      // An expired session is rejected inside the lease and replaced after it:
      // requesting the replacement while holding the lease can deadlock a
      // size-one pool. The callback keeps its own scope, as on the scoped path.
      return Effect.flatMap(
        Pool.use(pool, (connection): Effect.Effect<A | typeof rejected, E, R> =>
          expired(connection)
            ? Effect.as(Pool.invalidate(pool, connection), rejected)
            : Effect.scoped(run(connection))),
        (a): Effect.Effect<A, E | SqlError, R> =>
          a === rejected ? Effect.scoped(Effect.flatMap(get, f)) : Effect.succeed(a)
      )
    })

  const pgPool: PgPool = {
    [TypeId]: TypeId,
    config: options,
    get,
    reserve,
    use,
    invalidate: (connection) =>
      Pool.invalidate(pool, connectionInternals(connection).base as PgConnection.PgConnection),
    stats: Pool.stats(pool)
  }
  return pgPool
})
