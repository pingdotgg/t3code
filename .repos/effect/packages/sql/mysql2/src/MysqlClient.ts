/**
 * MySQL adapter for Effect SQL, backed by the `mysql2` driver.
 *
 * This module provides constructors and layers for a {@link MysqlClient} and
 * the generic Effect SQL client service. `make` creates a managed mysql2 pool,
 * checks the connection with `SELECT 1`, maps mysql2 failures to `SqlError`,
 * supports transaction connections, and exposes streaming queries through
 * mysql2 query streams. It also provides direct and config-backed layers plus a
 * MySQL statement compiler.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Redacted from "effect/Redacted"
import type { Scope } from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  SqlError,
  SqlSyntaxError,
  StatementTimeoutError,
  UniqueViolation,
  UnknownError
} from "effect/sql/SqlError"
import { asyncPauseResume } from "effect/sql/SqlStream"
import * as Statement from "effect/sql/Statement"
import * as Stream from "effect/Stream"
import * as Mysql from "mysql2"

const ATTR_DB_SYSTEM_NAME = "db.system.name"
const ATTR_DB_NAMESPACE = "db.namespace"
const ATTR_SERVER_ADDRESS = "server.address"
const ATTR_SERVER_PORT = "server.port"

const mysqlErrnoFromCause = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null || !("errno" in cause)) {
    return undefined
  }
  const errno = cause.errno
  return typeof errno === "number" ? errno : undefined
}

const mysqlConnectionErrorCodes = new Set([1040, 1042, 1043, 1129, 1130, 1203])
const mysqlAuthorizationErrorCodes = new Set([1044, 1142, 1143, 1227])
const mysqlSyntaxErrorCodes = new Set([1054, 1064, 1146])
const mysqlConstraintErrorCodes = new Set([1022, 1048, 1169, 1216, 1217, 1451, 1452, 1557])

const UNKNOWN_CONSTRAINT = "unknown"

const normalizeConstraintIdentifier = (identifier: unknown): string => {
  if (typeof identifier !== "string") {
    return UNKNOWN_CONSTRAINT
  }
  const trimmed = identifier.trim()
  return trimmed.length === 0 ? UNKNOWN_CONSTRAINT : trimmed
}

const mysqlCauseProperty = (cause: unknown, property: "constraint" | "message" | "sqlMessage"): unknown => {
  if (typeof cause !== "object" || cause === null || !(property in cause)) {
    return undefined
  }
  return (cause as Record<string, unknown>)[property]
}

const mysqlDuplicateEntryConstraintFromMessage = (message: unknown): string => {
  if (typeof message !== "string") {
    return UNKNOWN_CONSTRAINT
  }
  const match = /\bfor key\s+(?:'([^']*)'|\x60([^\x60]*)\x60|([^\s'\x60]+))/i.exec(message)
  return match === null ?
    UNKNOWN_CONSTRAINT :
    normalizeConstraintIdentifier(match[1] ?? match[2] ?? match[3])
}

const mysqlDuplicateEntryConstraintFromCause = (cause: unknown): string => {
  const constraint = normalizeConstraintIdentifier(mysqlCauseProperty(cause, "constraint"))
  if (constraint !== UNKNOWN_CONSTRAINT) {
    return constraint
  }
  const sqlMessageConstraint = mysqlDuplicateEntryConstraintFromMessage(mysqlCauseProperty(cause, "sqlMessage"))
  if (sqlMessageConstraint !== UNKNOWN_CONSTRAINT) {
    return sqlMessageConstraint
  }
  return mysqlDuplicateEntryConstraintFromMessage(mysqlCauseProperty(cause, "message"))
}

const classifyError = (
  cause: unknown,
  message: string,
  operation: string
) => {
  const props = { cause, message, operation }
  const errno = mysqlErrnoFromCause(cause)
  if (errno !== undefined) {
    if (mysqlConnectionErrorCodes.has(errno)) {
      return new ConnectionError(props)
    }
    if (errno === 1045) {
      return new AuthenticationError(props)
    }
    if (mysqlAuthorizationErrorCodes.has(errno)) {
      return new AuthorizationError(props)
    }
    if (mysqlSyntaxErrorCodes.has(errno)) {
      return new SqlSyntaxError(props)
    }
    if (errno === 1062) {
      return new UniqueViolation({ ...props, constraint: mysqlDuplicateEntryConstraintFromCause(cause) })
    }
    if (mysqlConstraintErrorCodes.has(errno)) {
      return new ConstraintError(props)
    }
    if (errno === 1213) {
      return new DeadlockError(props)
    }
    if (errno === 1205) {
      return new LockTimeoutError(props)
    }
    if (errno === 3024) {
      return new StatementTimeoutError(props)
    }
  }
  return new UnknownError(props)
}

/**
 * Runtime type identifier used to mark `MysqlClient` values.
 *
 * @stability unstable
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-mysql2/MysqlClient"

/**
 * Type-level identifier used to mark `MysqlClient` values.
 *
 * @stability unstable
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-mysql2/MysqlClient"

/**
 * mysql2-backed SQL client service, extending `SqlClient` with its runtime type marker and client configuration.
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export interface MysqlClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: MysqlClientConfig
}

/**
 * Service tag for the mysql2 SQL client service.
 *
 * **When to use**
 *
 * Use to access or provide a mysql2 client through the Effect context.
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export const MysqlClient = Context.Service<MysqlClient>("@effect/sql-mysql2/MysqlClient")

/**
 * Configuration for a mysql2 client, including connection URI or connection fields, pool options, span attributes, and query/result name transforms.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface MysqlClientConfig {
  /**
   * Connection URI. Setting this will override the other connection options
   */
  readonly url?: Redacted.Redacted | undefined

  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly database?: string | undefined
  readonly username?: string | undefined
  readonly password?: Redacted.Redacted | undefined

  readonly maxConnections?: number | undefined
  readonly connectionTTL?: Duration.Input | undefined

  /**
   * Options passed directly to the `mysql2` connection pool.
   *
   * @stability unstable
   */
  readonly poolConfig?: Mysql.PoolOptions | undefined

  /**
   * Use the text protocol instead of prepared statements, for proxies like
   * Cloudflare Hyperdrive that do not support `COM_STMT_PREPARE`.
   */
  readonly disablePreparedStatements?: boolean | undefined

  readonly spanAttributes?: Record<string, unknown> | undefined

  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

/**
 * Creates a scoped MySQL client backed by a managed mysql2 pool, verifying connectivity and supporting streaming queries through mysql2 query streams.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: MysqlClientConfig
): Effect.Effect<MysqlClient, SqlError, Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = makeCompiler(options.transformQueryNames)
    const transformRows = options.transformResultNames ?
      Statement.defaultTransforms(
        options.transformResultNames
      ).array :
      undefined
    const defaultMethod: "execute" | "query" = options.disablePreparedStatements === true ? "query" : "execute"

    class ConnectionImpl implements Connection {
      readonly conn: Mysql.PoolConnection
      // A transaction or reserved connection can be shared by several fibers.
      // Each statement or stream holds this permit from before its command is
      // queued until it has settled, so `KILL QUERY` only ever reaches the
      // statement that was interrupted.
      readonly permit = Semaphore.makeUnsafe(1)
      constructor(conn: Mysql.PoolConnection) {
        this.conn = conn
      }

      private runRaw(
        sql: string,
        values?: ReadonlyArray<any>,
        rowsAsArray = false,
        method: "execute" | "query" = defaultMethod
      ) {
        return this.permit.withPermit(Effect.callback<unknown, SqlError>((resume) => {
          const operation = method === "query" ? "executeUnprepared" : "execute"
          const statement = new ActiveStatement(connectionOptions, this.conn)
          ;(this.conn as any)[method]({
            sql,
            values,
            rowsAsArray
          }, (cause: unknown | null, results: unknown, _fields: any) => {
            // Once interrupted, the result is dropped.
            if (!statement.settle()) return
            if (cause) {
              resume(
                Effect.fail(new SqlError({ reason: classifyError(cause, "Failed to execute statement", operation) }))
              )
            } else {
              resume(Effect.succeed(results))
            }
          })
          return statement.cancel
        }))
      }

      private run(
        sql: string,
        values?: ReadonlyArray<any>,
        rowsAsArray = false,
        method: "execute" | "query" = defaultMethod
      ) {
        return this.runRaw(sql, values, rowsAsArray, method).pipe(
          Effect.map((results) => Array.isArray(results) ? results : [])
        )
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
        return this.runRaw(sql, params)
      }
      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return this.run(sql, params, true)
      }
      executeValuesUnprepared(sql: string, params: ReadonlyArray<unknown>) {
        return this.run(sql, params, true, "query")
      }
      executeUnprepared(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
      ) {
        return transformRows
          ? Effect.map(this.run(sql, params, false, "query"), transformRows)
          : this.run(sql, params, false, "query")
      }
      executeStream(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
      ) {
        const stream = queryStream(connectionOptions, this.conn, this.permit, sql, params)
        return transformRows
          ? Stream.mapArray(stream, (_) => transformRows(_) as any)
          : stream
      }
    }

    // Shared by the pool and the one-off connections that send `KILL QUERY`.
    const connectionOptions: Mysql.PoolOptions = options.url
      ? {
        uri: Redacted.value(options.url),
        multipleStatements: true,
        supportBigNumbers: true,
        connectionLimit: options.maxConnections!,
        idleTimeout: options.connectionTTL
          ? Duration.toMillis(Duration.fromInputUnsafe(options.connectionTTL))
          : undefined as any
      }
      : {
        ...options.poolConfig,
        host: options.host,
        port: options.port,
        database: options.database,
        user: options.username,
        password: options.password
          ? Redacted.value(options.password)
          : undefined,
        multipleStatements: true,
        supportBigNumbers: true,
        connectionLimit: options.maxConnections ?? options.poolConfig?.connectionLimit,
        idleTimeout: options.connectionTTL
          ? Duration.toMillis(Duration.fromInputUnsafe(options.connectionTTL))
          : options.poolConfig?.idleTimeout
      } as Mysql.PoolOptions
    const pool = Mysql.createPool(connectionOptions)

    yield* Effect.acquireRelease(
      Effect.callback<void, SqlError>((resume) => {
        ;(pool as any).query("SELECT 1", (cause: Error) => {
          if (cause) {
            resume(Effect.fail(
              new SqlError({
                reason: classifyError(cause, "MysqlClient: Failed to connect", "connect")
              })
            ))
          } else {
            resume(Effect.void)
          }
        })
      }),
      () =>
        Effect.callback<void>((resume) => {
          pool.end(() => resume(Effect.void))
        })
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        orElse: () =>
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                message: "MysqlClient: Connection timeout",
                cause: new Error("connection timeout"),
                operation: "connect"
              })
            })
          )
      })
    )

    const acquireConn = Effect.acquireRelease(
      Effect.callback<Mysql.PoolConnection, SqlError>((resume) => {
        let interrupted = false
        // mysql2 cannot remove a waiter from its queue, so a connection handed
        // over after interruption goes straight back to the pool.
        pool.getConnection((cause, conn) => {
          if (interrupted) {
            conn?.release()
            return
          }
          if (cause) {
            resume(
              Effect.fail(
                new SqlError({
                  reason: classifyError(cause, "Failed to acquire connection", "acquireConnection")
                })
              )
            )
          } else {
            resume(Effect.succeed(conn))
          }
        })
        return Effect.sync(() => {
          interrupted = true
        })
      }),
      (conn) => Effect.sync(() => conn.release()),
      { interruptible: true }
    )

    // Every statement checks out its own connection, so an interrupted
    // statement can be killed by thread id before the connection is reused.
    const acquirer = Effect.map(acquireConn, (conn) => new ConnectionImpl(conn))

    const spanAttributes: Array<[string, unknown]> = [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "mysql"],
      [ATTR_SERVER_ADDRESS, options.host ?? "localhost"],
      [ATTR_SERVER_PORT, options.port ?? 3306]
    ]

    if (options.database) {
      spanAttributes.push([ATTR_DB_NAMESPACE, options.database])
    }

    return Object.assign(
      yield* Client.make({
        driver: "mysql2",
        acquirer,
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        compiler,
        spanAttributes,
        transformRows
      }),
      { [TypeId]: TypeId as TypeId, config: options }
    )
  })

/**
 * Creates a layer from a `Config`-wrapped MySQL client configuration, providing both `MysqlClient` and `SqlClient`.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  config: Config.Wrap<MysqlClientConfig>
): Layer.Layer<MysqlClient | Client.SqlClient, Config.ConfigError | SqlError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(MysqlClient, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Creates a layer from a concrete MySQL client configuration, providing both `MysqlClient` and `SqlClient`.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: MysqlClientConfig
): Layer.Layer<MysqlClient | Client.SqlClient, Config.ConfigError | SqlError> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(MysqlClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Creates the MySQL statement compiler, using `?` placeholders and backtick-escaped identifiers.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const makeCompiler = (transform?: (_: string) => string) =>
  Statement.makeCompiler({
    dialect: "mysql",
    placeholder(_) {
      return `?`
    },
    onIdentifier: transform ?
      function(value, withoutTransform) {
        return withoutTransform ? escape(value) : escape(transform(value))
      } :
      escape,
    onCustom() {
      return ["", []]
    },
    onRecordUpdate() {
      return ["", []]
    }
  })

const escape = Statement.defaultEscape("`")

/**
 * How long interrupting a statement waits for `KILL QUERY` and the statement to
 * settle before destroying the connection instead.
 */
const cancelTimeoutMillis = 5000

/**
 * A statement running on a pool connection: records when the server is done
 * with it, and can stop it.
 */
class ActiveStatement {
  settled = false
  private cancelling = false
  private onSettled: (() => void) | undefined = undefined
  private readonly connectionOptions: Mysql.ConnectionOptions
  private readonly conn: Mysql.PoolConnection
  constructor(connectionOptions: Mysql.ConnectionOptions, conn: Mysql.PoolConnection) {
    this.connectionOptions = connectionOptions
    this.conn = conn
  }

  /**
   * Records that the server is done with the statement. Returns `true` when
   * the caller handles the outcome, and `false` when it was already recorded
   * or `cancel` is waiting for it.
   */
  settle(): boolean {
    if (this.settled) return false
    this.settled = true
    if (!this.cancelling) return true
    this.onSettled?.()
    return false
  }

  /**
   * Stops the statement and waits until it is safe to release the connection.
   *
   * Running this marks the statement as being cancelled before anything else,
   * so a settlement from then on belongs to the cancellation, even one that
   * happens before the kill is registered. If the statement has already
   * settled, nothing is killed.
   *
   * `KILL QUERY` goes over a one-off connection, because the pool may have no
   * free slot. The effect completes once the kill attempt has finished and the
   * statement has settled, so a late kill can never reach another statement on
   * the connection. Kill failures are ignored, including a kill connection that
   * cannot be created. If both do not happen within `cancelTimeoutMillis`, the
   * connection is destroyed, which removes it from the pool.
   */
  readonly cancel: Effect.Effect<void> = Effect.suspend(() => {
    this.cancelling = true
    return Effect.callback<void>((resume) => {
      if (this.settled) return resume(Effect.void)
      let done = false
      let killed = false
      let kill: Mysql.Connection | undefined
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        kill?.destroy()
        resume(Effect.void)
      }
      const onKilled = () => {
        killed = true
        if (this.settled) finish()
      }
      const timer = setTimeout(() => {
        this.conn.destroy()
        finish()
      }, cancelTimeoutMillis)
      this.onSettled = () => {
        if (killed) finish()
      }
      try {
        // A configured `stream` factory runs synchronously here and may throw.
        kill = Mysql.createConnection({ ...this.connectionOptions })
        kill.on("error", () => {})
        ;(kill as any).query("KILL QUERY ?", [this.conn.threadId], onKilled)
      } catch {
        onKilled()
      }
    })
  })
}

function queryStream(
  connectionOptions: Mysql.ConnectionOptions,
  conn: Mysql.PoolConnection,
  permit: Semaphore.Semaphore,
  sql: string,
  params?: ReadonlyArray<any>
) {
  return asyncPauseResume<any, SqlError>(Effect.fnUntraced(function*(emit) {
    const statement = new ActiveStatement(connectionOptions, conn)
    let query: any
    // The permit is returned as soon as the statement settles, because the
    // consumer may run its own statements on this connection before the
    // stream ends. When the stream is cancelled, it is kept until the statement
    // has been killed and seen to settle.
    let owned = true
    const release = Effect.suspend(() => {
      if (!owned) return Effect.void
      owned = false
      return permit.release(1)
    })
    // Taking the permit also installs the cleanup, so once the command starts
    // below there is no point at which interruption could leave it running.
    yield* Effect.acquireRelease(
      permit.take(1),
      () =>
        Effect.ensuring(
          Effect.suspend(() => {
            if (query === undefined) return Effect.void
            // Destroying the stream resumes a paused connection, so the
            // remaining rows are read and discarded while the statement is
            // killed. Rows that were already buffered are replayed
            // synchronously and can settle the statement before `destroy`
            // returns, in which case nothing is killed.
            query.destroy()
            return statement.cancel
          }),
          release
        ),
      { interruptible: true }
    )
    const command = (conn as any).query(sql, params)
    query = command.stream()
    // The command, unlike its stream, reports when the server is done with the
    // statement, even after the stream has been destroyed.
    const settle = () => {
      if (statement.settle()) Effect.runSync(release)
    }
    command.once("end", settle)
    command.once("error", settle)

    let buffer: Array<any> = []
    let taskPending = false
    query.on(
      "error",
      (cause: unknown) =>
        emit.fail(new SqlError({ reason: classifyError(cause, "Failed to stream statement", "stream") }))
    )
    query.on("data", (row: any) => {
      buffer.push(row)
      if (!taskPending) {
        taskPending = true
        queueMicrotask(() => {
          const items = buffer
          buffer = []
          emit.array(items)
          taskPending = false
        })
      }
    })
    query.on("end", () => {
      if (buffer.length > 0) {
        emit.array(buffer)
        buffer = []
      }
      emit.end()
    })

    return {
      onPause() {
        query.pause()
      },
      onResume() {
        query.resume()
      }
    }
  }))
}
