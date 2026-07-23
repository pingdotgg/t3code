/**
 * libSQL adapter for Effect SQL, backed by `@libsql/client`.
 *
 * Use this module to provide a {@link LibsqlClient} and the generic SQL client
 * service for Turso-hosted libSQL databases, local `file:` databases, embedded
 * replicas, migrations, tests, and server code that wants SQLite-compatible SQL
 * through Effect layers. The client uses Effect SQL's SQLite compiler and
 * classifies libSQL and SQLite failures as `SqlError`s.
 *
 * ## Mental model
 *
 * {@link make} and {@link layer} either create a scoped libSQL SDK client from
 * connection options or wrap a caller-owned client supplied with `liveClient`.
 * The Effect client serializes access to the underlying client because a libSQL
 * transaction is tied to that client. A top-level `withTransaction` opens a
 * write transaction, and nested transactions use SQLite savepoints.
 *
 * ## Common tasks
 *
 * - Use {@link layer} with concrete connection options, or {@link layerConfig}
 *   when the options should come from `Config`.
 * - Use a `file:` URL for local SQLite-compatible storage, a remote libSQL or
 *   Turso URL for hosted databases, and `syncUrl` for embedded replicas.
 * - Use `liveClient` when another component owns the `@libsql/client` instance
 *   and its lifetime.
 * - Use `transformQueryNames` and `transformResultNames` to map between Effect
 *   field names and database column names.
 *
 * ## Gotchas
 *
 * Direct calls made through the raw SDK client are not coordinated with Effect
 * SQL transactions. Remote transactions should stay short because they reserve
 * the client until commit or rollback. Row streaming is not implemented by this
 * adapter.
 *
 * @since 4.0.0
 */
import * as Libsql from "@libsql/client"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(cause, { message, operation })

/**
 * Runtime type identifier used to mark `LibsqlClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-libsql/LibsqlClient"

/**
 * Type-level identifier used to mark `LibsqlClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-libsql/LibsqlClient"

/**
 * libSQL-backed SQL client service, extending `SqlClient` with its runtime type marker and client configuration.
 *
 * @category models
 * @since 4.0.0
 */
export interface LibsqlClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: LibsqlClientConfig
}

/**
 * Service tag for the libSQL client service.
 *
 * **When to use**
 *
 * Use to access or provide a libSQL client through the Effect context.
 *
 * @category tags
 * @since 4.0.0
 */
export const LibsqlClient = Context.Service<LibsqlClient>("@effect/sql-libsql/LibsqlClient")

const LibsqlTransaction = Context.Service<readonly [LibsqlConnection, counter: number]>(
  "@effect/sql-libsql/LibsqlClient/LibsqlTransaction"
)

/**
 * Configuration for a libSQL client, either by supplying connection options or an existing live libSQL client.
 *
 * @category models
 * @since 4.0.0
 */
export type LibsqlClientConfig = LibsqlClientConfig.Full | LibsqlClientConfig.Live

/**
 * Namespace containing the configuration variants for `LibsqlClient`.
 *
 * @since 4.0.0
 */
export declare namespace LibsqlClientConfig {
  /**
   * Shared libSQL client options for span attributes and query/result name transformations.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Base {
    readonly spanAttributes?: Record<string, unknown> | undefined
    readonly transformResultNames?: ((str: string) => string) | undefined
    readonly transformQueryNames?: ((str: string) => string) | undefined
  }

  /**
   * Connection-based libSQL configuration used to create a managed client, including URL, credentials, sync, integer mode, TLS, and concurrency options.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Full extends Base {
    /**
     * The database URL.
     *
     * **Details**
     *
     * The client supports `libsql:`, `http:`/`https:`, `ws:`/`wss:` and `file:` URL. For more infomation,
     * please refer to the project README:
     *
     * https://github.com/libsql/libsql-client-ts#supported-urls
     */
    readonly url: string | URL
    /** Authentication token for the database. */
    readonly authToken?: Redacted.Redacted | undefined
    /** Encryption key for the database. */
    readonly encryptionKey?: Redacted.Redacted | undefined
    /** URL of a remote server to synchronize database with. */
    readonly syncUrl?: string | URL | undefined
    /** Sync interval in seconds. */
    readonly syncInterval?: number | undefined
    /**
     * Enables or disables TLS for `libsql:` URLs.
     *
     * **Details**
     *
     * By default, `libsql:` URLs use TLS. You can set this option to `false` to disable TLS.
     */
    readonly tls?: boolean | undefined
    /**
     * How to convert SQLite integers to JavaScript values.
     *
     * **Details**
     *
     * - `"number"` (default): returns SQLite integers as JavaScript `number`-s (double precision floats).
     * `number` cannot precisely represent integers larger than 2^53-1 in absolute value, so attempting to read
     * larger integers will throw a `RangeError`.
     * - `"bigint"`: returns SQLite integers as JavaScript `bigint`-s (arbitrary precision integers). Bigints can
     * precisely represent all SQLite integers.
     * - `"string"`: returns SQLite integers as strings.
     */
    readonly intMode?: "number" | "bigint" | "string" | undefined
    /**
     * Concurrency limit.
     *
     * **Details**
     *
     * By default, the client performs up to 20 concurrent requests. You can set this option to a higher
     * number to increase the concurrency limit or set it to 0 to disable concurrency limits completely.
     */
    readonly concurrency?: number | undefined
  }

  /**
   * Configuration that uses an existing libSQL client. The supplied `liveClient` is caller-owned and is not closed by the Effect client.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Live extends Base {
    readonly liveClient: Libsql.Client
  }
}

interface LibsqlConnection extends Connection {
  readonly beginTransaction: Effect.Effect<LibsqlConnection, SqlError>
  readonly commit: Effect.Effect<void, SqlError>
  readonly rollback: Effect.Effect<void, SqlError>
}

/**
 * Creates a scoped libSQL SQL client with transaction support. When given connection options it creates and closes the SDK client; when given `liveClient`, the caller retains ownership.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: LibsqlClientConfig
): Effect.Effect<LibsqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames ?
      Statement.defaultTransforms(
        options.transformResultNames
      ).array :
      undefined

    const spanAttributes: Array<[string, unknown]> = [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"]
    ]

    class LibsqlConnectionImpl implements LibsqlConnection {
      readonly sdk: Libsql.Client | Libsql.Transaction
      constructor(sdk: Libsql.Client | Libsql.Transaction) {
        this.sdk = sdk
      }

      run(
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) {
        return Effect.map(
          Effect.tryPromise({
            try: () => this.sdk.execute({ sql, args: params as Array<any> }),
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
          }),
          (results) => results.rows
        )
      }

      runRaw(
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) {
        return Effect.tryPromise({
          try: () => this.sdk.execute({ sql, args: params as Array<any> }),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
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
        return this.runRaw(sql, params)
      }
      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return Effect.map(this.run(sql, params), (rows) => rows.map((row) => Array.from(row) as Array<any>))
      }
      executeUnprepared(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
      ) {
        return this.execute(sql, params, transformRows)
      }
      executeStream() {
        return Stream.die("executeStream not implemented")
      }
      get beginTransaction() {
        return Effect.map(
          Effect.tryPromise({
            try: () => (this.sdk as Libsql.Client).transaction("write"),
            catch: (cause) =>
              new SqlError({ reason: classifyError(cause, "Failed to begin transaction", "beginTransaction") })
          }),
          (tx) => new LibsqlConnectionImpl(tx)
        )
      }
      get commit() {
        return Effect.tryPromise({
          try: () => (this.sdk as Libsql.Transaction).commit(),
          catch: (cause) =>
            new SqlError({ reason: classifyError(cause, "Failed to commit transaction", "commitTransaction") })
        })
      }
      get rollback() {
        return Effect.tryPromise({
          try: () => (this.sdk as Libsql.Transaction).rollback(),
          catch: (cause) =>
            new SqlError({ reason: classifyError(cause, "Failed to rollback transaction", "rollbackTransaction") })
        })
      }
    }

    const connection = "liveClient" in options
      ? new LibsqlConnectionImpl(options.liveClient)
      : yield* Effect.map(
        Effect.acquireRelease(
          Effect.sync(() =>
            Libsql.createClient(
              {
                ...options,
                authToken: Redacted.isRedacted(options.authToken)
                  ? Redacted.value(options.authToken)
                  : options.authToken,
                encryptionKey: Redacted.isRedacted(options.encryptionKey)
                  ? Redacted.value(options.encryptionKey)
                  : options.encryptionKey,
                url: options.url.toString(),
                syncUrl: options.syncUrl?.toString()
              } as Libsql.Config
            )
          ),
          (sdk) => Effect.sync(() => sdk.close())
        ),
        (sdk) => new LibsqlConnectionImpl(sdk)
      )
    const semaphore = yield* Semaphore.make(1)

    const withTransaction = Client.makeWithTransaction({
      transactionService: LibsqlTransaction,
      spanAttributes,
      acquireConnection: Effect.uninterruptibleMask(Effect.fnUntraced(function*(restore) {
        const scope = Scope.makeUnsafe()
        yield* restore(semaphore.take(1))
        yield* Scope.addFinalizer(scope, semaphore.release(1))
        const conn = yield* connection.beginTransaction
        return [scope, conn] as const
      })),
      begin: () => Effect.void, // already begun in acquireConnection
      savepoint: (conn, id) => conn.executeRaw(`SAVEPOINT effect_sql_${id};`, []),
      commit: (conn) => conn.commit,
      rollback: (conn) => conn.rollback,
      rollbackSavepoint: (conn, id) => conn.executeRaw(`ROLLBACK TO SAVEPOINT effect_sql_${id};`, [])
    })

    const acquirer = Effect.flatMap(
      Effect.serviceOption(LibsqlTransaction),
      Option.match({
        onNone: () => semaphore.withPermits(1)(Effect.succeed(connection as LibsqlConnection)),
        onSome: ([conn]) => Effect.succeed(conn)
      })
    )

    return Object.assign(
      yield* Client.make({
        acquirer,
        compiler,
        spanAttributes,
        transformRows
      }),
      {
        [TypeId]: TypeId as TypeId,
        config: options,
        withTransaction,
        sdk: connection.sdk
      }
    )
  })

/**
 * Creates a layer from a `Config`-wrapped libSQL client configuration, providing both `LibsqlClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig: (
  config: Config.Wrap<LibsqlClientConfig>
) => Layer.Layer<LibsqlClient | Client.SqlClient, Config.ConfigError> = (
  config: Config.Wrap<LibsqlClientConfig>
): Layer.Layer<LibsqlClient | Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(LibsqlClient, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Creates a layer from a concrete libSQL client configuration, providing both `LibsqlClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: LibsqlClientConfig
): Layer.Layer<LibsqlClient | Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(LibsqlClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
