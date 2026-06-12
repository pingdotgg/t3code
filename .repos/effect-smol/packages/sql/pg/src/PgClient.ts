/**
 * PostgreSQL driver for Effect SQL, backed by the `pg` package.
 *
 * Use this module to provide a {@link PgClient} and the generic `SqlClient`
 * service from pool settings, a single managed `pg.Client`, an existing
 * `pg.Pool`, or custom connection acquirers. The client uses Effect SQL's
 * PostgreSQL compiler, classifies common PostgreSQL failures as `SqlError`s,
 * and adds PostgreSQL-specific JSON fragments plus LISTEN/NOTIFY operations.
 *
 * ## Mental model
 *
 * Pool-backed clients acquire a connection for each operation. Transactions and
 * cursor streams keep a dedicated connection for their scope, so they consume
 * pool capacity while active. Clients built from one `pg.Client` serialize
 * query access through that client; set `acquireForStream` in
 * {@link makeClient} when streams or listeners need separate clients.
 *
 * ## Common tasks
 *
 * - Use {@link layer} with concrete pool settings, or {@link layerConfig} when
 *   settings should come from `Config`.
 * - Use {@link make} for a scoped pool-backed client without immediately
 *   turning it into a layer.
 * - Use {@link fromPool} or {@link fromClient} when another component owns
 *   acquisition of the underlying `pg` resources.
 * - Use `client.json`, `client.listen`, and `client.notify` for
 *   PostgreSQL-specific values and notifications.
 *
 * ## Gotchas
 *
 * LISTEN opens a scoped long-lived client and issues `UNLISTEN` when the stream
 * scope closes, so keep listener streams scoped for exactly the period
 * notifications are needed. Long-running transactions, streams, and listeners
 * can hold onto database connections even while other fibers continue to use
 * the same `PgClient`.
 *
 * @since 4.0.0
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Number from "effect/Number"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as RcRef from "effect/RcRef"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import type * as SqlConnection from "effect/unstable/sql/SqlConnection"
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  SerializationError,
  SqlError,
  SqlSyntaxError,
  StatementTimeoutError,
  UniqueViolation,
  UnknownError
} from "effect/unstable/sql/SqlError"
import type { Custom, Fragment } from "effect/unstable/sql/Statement"
import * as Statement from "effect/unstable/sql/Statement"
import type { Duplex } from "node:stream"
import type { ConnectionOptions } from "node:tls"
import * as Pg from "pg"
import * as PgConnString from "pg-connection-string"
import Cursor from "pg-cursor"

/**
 * Runtime type identifier used to mark `PgClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-pg/PgClient"

/**
 * Type-level identifier used to mark `PgClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-pg/PgClient"

/**
 * PostgreSQL client service, extending `SqlClient` with JSON parameter fragments and LISTEN/NOTIFY helpers.
 *
 * @category models
 * @since 4.0.0
 */
export interface PgClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: PgClientConfig
  readonly json: (_: unknown) => Fragment
  readonly listen: (channel: string) => Stream.Stream<string, SqlError>
  readonly notify: (channel: string, payload: string) => Effect.Effect<void, SqlError>
}

/**
 * Service tag for the PostgreSQL client service.
 *
 * **When to use**
 *
 * Use to access or provide a PostgreSQL client through the Effect context.
 *
 * @category tags
 * @since 4.0.0
 */
export const PgClient = Context.Service<PgClient>("@effect/sql-pg/PgClient")

/**
 * Configuration for a PostgreSQL client, including connection, TLS, custom stream, application name, type parser, JSON transform, and query/result name transform options.
 *
 * @category constructors
 * @since 4.0.0
 */
export interface PgClientConfig {
  readonly url?: Redacted.Redacted | undefined

  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly path?: string | undefined
  readonly ssl?: boolean | ConnectionOptions | undefined
  readonly database?: string | undefined
  readonly username?: string | undefined
  readonly password?: Redacted.Redacted | undefined

  readonly connectTimeout?: Duration.Input | undefined

  readonly stream?: (() => Duplex) | undefined

  readonly applicationName?: string | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined

  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
  readonly transformJson?: boolean | undefined
  readonly types?: Pg.CustomTypesConfig | undefined
}

/**
 * PostgreSQL pool configuration, extending `PgClientConfig` with idle timeout, pool size, and connection lifetime settings.
 *
 * @category constructors
 * @since 4.0.0
 */
export interface PgPoolConfig extends PgClientConfig {
  readonly idleTimeout?: Duration.Input | undefined

  readonly maxConnections?: number | undefined
  readonly minConnections?: number | undefined
  readonly connectionTTL?: Duration.Input | undefined
}

/**
 * Creates a scoped PostgreSQL client backed by a managed `pg` connection pool.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: PgPoolConfig): Effect.Effect<PgClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  fromPool({
    ...options,
    acquire: Effect.gen(function*() {
      const pool = new Pg.Pool({
        connectionString: options.url ? Redacted.value(options.url) : undefined,
        user: options.username,
        host: options.host,
        database: options.database,
        password: options.password ? Redacted.value(options.password) : undefined,
        ssl: options.ssl,
        port: options.port,
        ...(options.stream ? { stream: options.stream } : {}),
        connectionTimeoutMillis: options.connectTimeout
          ? Duration.toMillis(Duration.fromInputUnsafe(options.connectTimeout))
          : undefined,
        idleTimeoutMillis: options.idleTimeout
          ? Duration.toMillis(Duration.fromInputUnsafe(options.idleTimeout))
          : undefined,
        max: options.maxConnections,
        min: options.minConnections,
        maxLifetimeSeconds: options.connectionTTL
          ? Duration.toSeconds(Duration.fromInputUnsafe(options.connectionTTL))
          : undefined,
        application_name: options.applicationName ?? "@effect/sql-pg",
        types: options.types
      })

      pool.on("error", (_err) => {})

      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => pool.query("SELECT 1"),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "PgClient: Failed to connect", "connect") })
        }),
        () =>
          Effect.promise(() => pool.end()).pipe(
            Effect.timeoutOption(1000)
          ),
        { interruptible: true }
      ).pipe(
        Effect.timeoutOrElse({
          duration: options.connectTimeout ?? Duration.seconds(5),
          orElse: () =>
            Effect.fail(
              new SqlError({
                reason: new ConnectionError({
                  cause: new Error("Connection timed out"),
                  message: "PgClient: Connection timed out",
                  operation: "connect"
                })
              })
            )
        })
      )

      return pool
    })
  })

/**
 * Creates a scoped PostgreSQL client backed by a managed single `pg` client, optionally acquiring a separate client for streaming and LISTEN operations.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeClient = (
  options: PgClientConfig & {
    /**
     * Whether to acquire a separate client for each sql.stream / sql.listen
     */
    readonly acquireForStream?: boolean | undefined
  }
): Effect.Effect<PgClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  fromClient({
    ...options,
    acquire: Effect.gen(function*() {
      const client = new Pg.Client({
        connectionString: options.url ? Redacted.value(options.url) : undefined,
        user: options.username,
        host: options.host,
        database: options.database,
        password: options.password ? Redacted.value(options.password) : undefined,
        ssl: options.ssl,
        port: options.port,
        ...(options.stream ? { stream: options.stream } : {}),
        application_name: options.applicationName ?? "@effect/sql-pg",
        types: options.types
      })
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => client.query("SELECT 1"),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "PgClient: Failed to connect", "connect") })
        }),
        () =>
          Effect.promise(() => client.end()).pipe(
            Effect.timeoutOption(1000)
          ),
        { interruptible: true }
      ).pipe(
        Effect.timeoutOrElse({
          duration: options.connectTimeout ?? Duration.seconds(5),
          orElse: () =>
            Effect.fail(
              new SqlError({
                reason: new ConnectionError({
                  cause: new Error("Connection timed out"),
                  message: "PgClient: Connection timed out",
                  operation: "connect"
                })
              })
            )
        })
      )

      return client
    }),
    acquireForStream: options.acquireForStream ?? false
  })

/**
 * Builds a PostgreSQL client from a scoped `pg` pool acquisition effect, deriving transaction, streaming, and LISTEN/NOTIFY support from that pool.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromPool = Effect.fnUntraced(function*(
  options: {
    readonly acquire: Effect.Effect<Pg.Pool, SqlError, Scope.Scope>

    readonly applicationName?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined

    readonly transformResultNames?: ((str: string) => string) | undefined
    readonly transformQueryNames?: ((str: string) => string) | undefined
    readonly transformJson?: boolean | undefined
    readonly types?: Pg.CustomTypesConfig | undefined
  }
): Effect.fn.Return<PgClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  const pool = yield* options.acquire

  const makeConection = (client?: Pg.PoolClient) =>
    new ConnectionImpl(
      function runWithClient<A>(f: (client: Pg.ClientBase, resume: (_: Effect.Effect<A, SqlError>) => void) => void) {
        if (client !== undefined) {
          return Effect.callback<A, SqlError>((resume) => {
            f(client!, resume)
            return makeCancel(pool, client!)
          })
        }
        return Effect.callback<A, SqlError>((resume) => {
          let done = false
          let cancel: Effect.Effect<void> | undefined = undefined
          let client: Pg.PoolClient | undefined = undefined
          function onError(cause: Error) {
            cleanup(cause)
            resume(Effect.fail(new SqlError({ reason: classifyError(cause, "Connection error", "acquireConnection") })))
          }
          function cleanup(cause?: Error) {
            if (!done) client?.release(cause)
            done = true
            client?.off("error", onError)
          }
          pool.connect((cause, client_) => {
            if (cause) {
              return resume(
                Effect.fail(
                  new SqlError({
                    reason: classifyError(cause, "Failed to acquire connection", "acquireConnection")
                  })
                )
              )
            } else if (!client_) {
              return resume(
                Effect.fail(
                  new SqlError({
                    reason: new ConnectionError({
                      message: "Failed to acquire connection",
                      cause: new Error("No client returned"),
                      operation: "acquireConnection"
                    })
                  })
                )
              )
            } else if (done) {
              client_.release()
              return
            }
            client = client_
            client.once("error", onError)
            cancel = makeCancel(pool, client)
            f(client, (eff) => {
              cleanup()
              resume(eff)
            })
          })
          return Effect.suspend(() => {
            if (!cancel) {
              cleanup()
              return Effect.void
            }
            return Effect.ensuring(cancel, Effect.sync(cleanup))
          })
        })
      },
      client ? Effect.succeed(client) : reserveRaw
    )

  const reserveRaw = Effect.callback<Pg.PoolClient, SqlError, Scope.Scope>((resume) => {
    const fiber = Fiber.getCurrent()!
    const scope = Context.getUnsafe(fiber.context, Scope.Scope)
    let cause: Error | undefined = undefined
    function onError(cause_: Error) {
      cause = cause_
    }
    pool.connect((err, client, release) => {
      if (err) {
        return resume(
          Effect.fail(
            new SqlError({
              reason: classifyError(
                err,
                "Failed to acquire connection for transaction",
                "acquireConnection"
              )
            })
          )
        )
      } else if (!client) {
        return resume(
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                message: "Failed to acquire connection for transaction",
                cause: new Error("No client returned"),
                operation: "acquireConnection"
              })
            })
          )
        )
      }
      client.on("error", onError)
      resume(Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            client.off("error", onError)
            release(cause)
          })
        ),
        client
      ))
    })
  })
  const reserve = Effect.map(reserveRaw, makeConection)

  const onListenClientError = (_: Error) => {
  }

  const listenAcquirer = yield* RcRef.make({
    acquire: Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new Pg.Client(pool.options)
          await client.connect()
          client.on("error", onListenClientError)
          return client
        },
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to acquire connection for listen", "acquireConnection")
          })
      }),
      (client) =>
        Effect.promise(() => {
          client.off("error", onListenClientError)
          return client.end()
        }).pipe(
          Effect.timeoutOption(1000)
        ),
      { interruptible: true }
    )
  })

  let config: PgClientConfig = {
    url: pool.options.connectionString ? Redacted.make(pool.options.connectionString) : undefined,
    host: pool.options.host,
    port: pool.options.port,
    database: pool.options.database,
    username: pool.options.user,
    password: typeof pool.options.password === "string" ? Redacted.make(pool.options.password) : undefined,
    ssl: pool.options.ssl,
    applicationName: pool.options.application_name,
    types: pool.options.types
  }
  if (pool.options.connectionString) {
    // @effect-diagnostics-next-line tryCatchInEffectGen:off
    try {
      const parsed = PgConnString.parse(pool.options.connectionString)
      config = {
        ...config,
        host: config.host ?? parsed.host ?? undefined,
        port: config.port ?? (parsed.port ? Option.getOrUndefined(Number.parse(parsed.port)) : undefined),
        username: config.username ?? parsed.user ?? undefined,
        password: config.password ?? (parsed.password ? Redacted.make(parsed.password) : undefined),
        database: config.database ?? parsed.database ?? undefined
      }
    } catch {
      //
    }
  }

  return yield* makeWith({
    acquirer: Effect.succeed(makeConection()),
    transactionAcquirer: reserve,
    listenAcquirer: RcRef.get(listenAcquirer),
    config,
    spanAttributes: options.spanAttributes,
    transformResultNames: options.transformResultNames,
    transformQueryNames: options.transformQueryNames,
    transformJson: options.transformJson
  })
})

/**
 * Builds a PostgreSQL client from a scoped `pg` client acquisition effect, serializing access when sharing the client and optionally using separate clients for streams and LISTEN.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromClient = Effect.fnUntraced(function*(
  options: {
    readonly acquire: Effect.Effect<Pg.Client, SqlError, Scope.Scope>

    /**
     * Whether to acquire a separate client for each sql.stream / sql.listen.
     */
    readonly acquireForStream: boolean

    readonly applicationName?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined

    readonly transformResultNames?: ((str: string) => string) | undefined
    readonly transformQueryNames?: ((str: string) => string) | undefined
    readonly transformJson?: boolean | undefined
    readonly types?: Pg.CustomTypesConfig | undefined
  }
): Effect.fn.Return<PgClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  function onError() {}
  const acquireWithErrorHandler = options.acquire.pipe(
    Effect.tap((client) => {
      client.on("error", onError)
      return Effect.addFinalizer(() => {
        client.off("error", onError)
        return Effect.void
      })
    })
  )
  const client = yield* acquireWithErrorHandler

  const semaphore = Semaphore.makeUnsafe(1)
  let streamClient = options.acquireForStream ? acquireWithErrorHandler : Effect.acquireRelease(
    Effect.as(semaphore.take(1), client),
    () => semaphore.release(1)
  )

  const makeConection = (client: Pg.Client) =>
    new ConnectionImpl(
      function runWithClient<A>(f: (client: Pg.ClientBase, resume: (_: Effect.Effect<A, SqlError>) => void) => void) {
        return Effect.callback<A, SqlError>((resume) => {
          f(client, resume)
        })
      },
      streamClient
    )
  const connection = makeConection(client)
  const acquirer = semaphore.withPermit(Effect.succeed(connection))

  const config: PgClientConfig = {
    ...options,
    host: client.host,
    port: client.port,
    database: client.database,
    username: client.user,
    password: typeof client.password === "string" ? Redacted.make(client.password) : undefined,
    ssl: client.ssl
  }

  return yield* makeWith({
    acquirer,
    transactionAcquirer: acquirer,
    listenAcquirer: streamClient,
    config,
    spanAttributes: options.spanAttributes,
    transformResultNames: options.transformResultNames,
    transformQueryNames: options.transformQueryNames,
    transformJson: options.transformJson
  })
})

/**
 * Creates a `PgClient` from SQL connection acquirers, a LISTEN acquirer, client configuration, and transformation options.
 *
 * **When to use**
 *
 * Use to build a PostgreSQL client from custom connection acquisition logic
 * instead of the built-in pool or single-client constructors.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeWith = Effect.fnUntraced(function*(
  options: {
    readonly acquirer: SqlConnection.Acquirer
    readonly transactionAcquirer: SqlConnection.Acquirer
    readonly listenAcquirer: Effect.Effect<Pg.ClientBase, SqlError, Scope.Scope>

    readonly config: PgClientConfig
    readonly spanAttributes?: Record<string, unknown> | undefined

    readonly transformResultNames?: ((str: string) => string) | undefined
    readonly transformQueryNames?: ((str: string) => string) | undefined
    readonly transformJson?: boolean | undefined
  }
): Effect.fn.Return<PgClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  const compiler = makeCompiler(
    options.transformQueryNames,
    options.transformJson
  )
  const transformRows = options.transformResultNames ?
    Statement.defaultTransforms(
      options.transformResultNames,
      options.transformJson
    ).array :
    undefined

  const config = options.config

  return Object.assign(
    yield* Client.make({
      acquirer: options.acquirer,
      transactionAcquirer: options.transactionAcquirer,
      compiler,
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        [ATTR_DB_SYSTEM_NAME, "postgresql"],
        [ATTR_DB_NAMESPACE, config.database ?? config.username ?? "postgres"],
        [ATTR_SERVER_ADDRESS, config.host ?? "localhost"],
        [ATTR_SERVER_PORT, config.port ?? 5432]
      ],
      transformRows
    }),
    {
      [TypeId]: TypeId as TypeId,
      config: options.config,
      json: (_: unknown) => Statement.fragment([PgJson(_)]),
      listen: (channel: string) =>
        Stream.callback<string, SqlError>(Effect.fnUntraced(function*(queue) {
          const client = yield* options.listenAcquirer
          function onNotification(msg: Pg.Notification) {
            if (msg.channel === channel && msg.payload) {
              Queue.offerUnsafe(queue, msg.payload)
            }
          }
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => {
              client.off("notification", onNotification)
              return client.query(`UNLISTEN ${Pg.escapeIdentifier(channel)}`)
            })
          )
          yield* Effect.tryPromise({
            try: () => client.query(`LISTEN ${Pg.escapeIdentifier(channel)}`),
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to listen", "listen") })
          })
          client.on("notification", onNotification)
        })),
      notify: (channel: string, payload: string) =>
        Effect.asVoid(Effect.scoped(Effect.flatMap(
          options.acquirer,
          (conn) => conn.executeRaw(`SELECT pg_notify($1, $2)`, [channel, payload])
        )))
    }
  )
})

class ConnectionImpl implements Connection {
  constructor(
    runWithClient: <A>(
      f: (client: Pg.ClientBase, resume: (_: Effect.Effect<A, SqlError>) => void) => void
    ) => Effect.Effect<A, SqlError>,
    reserve: Effect.Effect<Pg.ClientBase, SqlError, Scope.Scope>
  ) {
    this.runWithClient = runWithClient
    this.reserve = reserve
  }

  private readonly runWithClient: <A>(
    f: (client: Pg.ClientBase, resume: (_: Effect.Effect<A, SqlError>) => void) => void
  ) => Effect.Effect<A, SqlError>
  private readonly reserve: Effect.Effect<Pg.ClientBase, SqlError, Scope.Scope>

  private run(query: string, params: ReadonlyArray<unknown>) {
    return this.runWithClient<ReadonlyArray<any>>((client, resume) => {
      client.query(query, params as any, (err, result) => {
        if (err) {
          resume(
            Effect.fail(new SqlError({ reason: classifyError(err, "Failed to execute statement", "execute") }))
          )
        } else {
          // Multi-statement queries return an array of results
          resume(Effect.succeed(
            Array.isArray(result)
              ? result.map((r) => r.rows ?? [])
              : result.rows ?? []
          ))
        }
      })
    })
  }

  execute(
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
  ) {
    return transformRows
      ? Effect.map(this.run(sql, params), transformRows)
      : this.run(sql, params)
  }
  executeRaw(sql: string, params: ReadonlyArray<unknown>) {
    return this.runWithClient<Pg.Result>((client, resume) => {
      client.query(sql, params as any, (err, result) => {
        if (err) {
          resume(
            Effect.fail(new SqlError({ reason: classifyError(err, "Failed to execute statement", "execute") }))
          )
        } else {
          resume(Effect.succeed(result))
        }
      })
    })
  }
  executeWithoutTransform(sql: string, params: ReadonlyArray<unknown>) {
    return this.run(sql, params)
  }
  executeValues(sql: string, params: ReadonlyArray<unknown>) {
    return this.runWithClient<ReadonlyArray<any>>((client, resume) => {
      client.query(
        {
          text: sql,
          rowMode: "array",
          values: params as Array<string>
        },
        (err, result) => {
          if (err) {
            resume(
              Effect.fail(new SqlError({ reason: classifyError(err, "Failed to execute statement", "execute") }))
            )
          } else {
            resume(Effect.succeed(result.rows))
          }
        }
      )
    })
  }
  executeUnprepared(
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
  ) {
    return this.execute(sql, params, transformRows)
  }
  executeStream(
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
  ) {
    // oxlint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return Stream.fromChannel(Channel.fromTransform(Effect.fnUntraced(function*(_, scope) {
      const client = yield* Scope.provide(self.reserve, scope)
      yield* Scope.addFinalizer(scope, Effect.promise(() => cursor.close()))
      const cursor = client.query(new Cursor(sql, params as any))
      // @effect-diagnostics-next-line returnEffectInGen:off
      return Effect.callback<Arr.NonEmptyReadonlyArray<any>, SqlError | Cause.Done>((resume) => {
        cursor.read(128, (err, rows) => {
          if (err) {
            resume(Effect.fail(new SqlError({ reason: classifyError(err, "Failed to execute statement", "stream") })))
          } else if (Arr.isArrayNonEmpty(rows)) {
            resume(Effect.succeed(transformRows ? transformRows(rows) as any : rows))
          } else {
            resume(Cause.done())
          }
        })
      })
    })))
  }
}

const cancelEffects = new WeakMap<Pg.PoolClient, Effect.Effect<void> | undefined>()
const makeCancel = (pool: Pg.Pool, client: Pg.PoolClient) => {
  if (cancelEffects.has(client)) {
    return cancelEffects.get(client)!
  }
  const processId = (client as any).processID
  const eff = processId !== undefined
    // query cancelation is best-effort, so we don't fail if it doesn't work
    ? Effect.callback<void>((resume) => {
      if (pool.ending) return resume(Effect.void)
      pool.query(`SELECT pg_cancel_backend(${processId})`, () => {
        resume(Effect.void)
      })
    }).pipe(
      Effect.interruptible,
      Effect.timeoutOption(5000)
    )
    : undefined
  cancelEffects.set(client, eff)
  return eff
}

/**
 * Creates a layer from an effect that acquires a `PgClient`, providing both `PgClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerFrom = <E, R>(
  acquire: Effect.Effect<PgClient, E, R>
): Layer.Layer<PgClient | Client.SqlClient, E, Exclude<R, Scope.Scope | Reactivity.Reactivity>> =>
  Layer.effectContext(
    Effect.map(acquire, (client) =>
      Context.make(PgClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer)) as any

/**
 * Creates a layer from a `Config`-wrapped PostgreSQL pool configuration, providing both `PgClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig: (
  config: Config.Wrap<PgPoolConfig>
) => Layer.Layer<PgClient | Client.SqlClient, Config.ConfigError | SqlError> = (
  config: Config.Wrap<PgPoolConfig>
): Layer.Layer<PgClient | Client.SqlClient, Config.ConfigError | SqlError> =>
  layerFrom(Effect.flatMap(
    Config.unwrap(config),
    make
  ))

/**
 * Creates a layer from a concrete PostgreSQL pool configuration, providing both `PgClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: PgPoolConfig
): Layer.Layer<PgClient | Client.SqlClient, SqlError> => layerFrom(make(config))

/**
 * Creates the PostgreSQL statement compiler, using `$1` placeholders, double-quoted identifiers, PostgreSQL returning clauses, and optional JSON value transformation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCompiler = (
  transform?: (_: string) => string,
  transformJson = true
): Statement.Compiler => {
  const transformValue = transformJson && transform
    ? Statement.defaultTransforms(transform).value
    : undefined

  return Statement.makeCompiler<PgCustom>({
    dialect: "pg",
    placeholder(_) {
      return `$${_}`
    },
    onIdentifier: transform ?
      function(value, withoutTransform) {
        return withoutTransform ? escape(value) : escape(transform(value))
      } :
      escape,
    onRecordUpdate(placeholders, valueAlias, valueColumns, values, returning) {
      return [
        `(values ${placeholders}) AS ${valueAlias}${valueColumns}${returning ? ` RETURNING ${returning[0]}` : ""}`,
        returning ?
          values.flat().concat(returning[1]) :
          values.flat()
      ]
    },
    onCustom(type, placeholder, withoutTransform) {
      switch (type.kind) {
        case "PgJson": {
          return [
            placeholder(undefined),
            [
              withoutTransform || transformValue === undefined
                ? type.paramA
                : transformValue(type.paramA)
            ]
          ]
        }
      }
    }
  })
}

const escape = Statement.defaultEscape("\"")

/**
 * PostgreSQL-specific custom statement fragments supported by the compiler, currently JSON parameter fragments.
 *
 * @category custom types
 * @since 4.0.0
 */
export type PgCustom = PgJson

/**
 * @category custom types
 * @since 4.0.0
 */
interface PgJson extends Custom<"PgJson", unknown> {}
/**
 * @category custom types
 * @since 4.0.0
 */
const PgJson = Statement.custom<PgJson>("PgJson")

const ATTR_DB_SYSTEM_NAME = "db.system.name"
const ATTR_DB_NAMESPACE = "db.namespace"
const ATTR_SERVER_ADDRESS = "server.address"
const ATTR_SERVER_PORT = "server.port"

const pgCodeFromCause = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" ? code : undefined
}

const pgConstraintFromCause = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null || !("constraint" in cause)) {
    return "unknown"
  }
  const constraint = cause.constraint
  if (typeof constraint !== "string") {
    return "unknown"
  }
  const normalized = constraint.trim()
  return normalized.length === 0 ? "unknown" : normalized
}

const classifyError = (
  cause: unknown,
  message: string,
  operation: string
) => {
  const props = { cause, message, operation }
  const code = pgCodeFromCause(cause)
  if (code !== undefined) {
    if (code.startsWith("08")) {
      return new ConnectionError(props)
    }
    if (code.startsWith("28")) {
      return new AuthenticationError(props)
    }
    if (code === "42501") {
      return new AuthorizationError(props)
    }
    if (code.startsWith("42")) {
      return new SqlSyntaxError(props)
    }
    if (code === "23505") {
      return new UniqueViolation({ ...props, constraint: pgConstraintFromCause(cause) })
    }
    if (code.startsWith("23")) {
      return new ConstraintError(props)
    }
    if (code === "40P01") {
      return new DeadlockError(props)
    }
    if (code === "40001") {
      return new SerializationError(props)
    }
    if (code === "55P03") {
      return new LockTimeoutError(props)
    }
    if (code === "57014") {
      return new StatementTimeoutError(props)
    }
  }
  return new UnknownError(props)
}
