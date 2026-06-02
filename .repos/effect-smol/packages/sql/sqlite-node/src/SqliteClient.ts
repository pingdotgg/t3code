/**
 * Node.js SQLite driver for Effect SQL, backed by `better-sqlite3`.
 *
 * Use this module to provide a scoped {@link SqliteClient} for file-backed or
 * in-memory SQLite databases in Node.js. The provided layers install both the
 * SQLite-specific service and the generic `SqlClient`, making the module useful
 * for local applications, tests, migrations, development tools, and embedded
 * persistence that need Effect SQL query compilation with SQLite-specific
 * operations.
 *
 * ## Mental model
 *
 * Each client owns one scoped `better-sqlite3` database handle and serializes
 * all SQL access through it. Because `better-sqlite3` executes statements
 * synchronously, a long-running query or transaction holds the serialized
 * connection until it completes. Prepared statements are cached by SQL text and
 * result-name transforms are applied after rows are read.
 *
 * The service adds Node SQLite capabilities on top of the generic `SqlClient`:
 * database export, file backup, and native extension loading.
 *
 * ## Common tasks
 *
 * - Use {@link layer} with a concrete filename and options.
 * - Use {@link layerConfig} when the filename or flags should come from
 *   `Config`.
 * - Use {@link make} inside a custom scoped layer when you need to manage the
 *   client lifecycle directly.
 * - Use `client.export`, `client.backup`, or `client.loadExtension` for
 *   operations that are specific to this Node SQLite driver.
 *
 * ## Gotchas
 *
 * WAL mode is enabled by default. Set `disableWAL` for read-only databases or
 * when the database file or directory cannot be updated with SQLite WAL side
 * files. Separate database handles or processes can still contend for SQLite
 * write locks even though access through one client is serialized.
 *
 * Safe integer handling follows the generic `SqlClient` fiber-local setting.
 * `executeStream` is not implemented for this driver, and SQLite does not
 * support `updateValues`.
 *
 * @since 4.0.0
 */
import Sqlite from "better-sqlite3"
import * as Cache from "effect/Cache"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
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
 * Runtime type identifier used to mark Node `SqliteClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-sqlite-node/SqliteClient"

/**
 * Type-level identifier used to mark Node `SqliteClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-sqlite-node/SqliteClient"

/**
 * Node SQLite client service, extending `SqlClient` with database export, backup, and extension loading helpers. `updateValues` is not supported.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: SqliteClientConfig
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly backup: (destination: string) => Effect.Effect<BackupMetadata, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>

  /** Not supported in sqlite */
  readonly updateValues: never
}

/**
 * Metadata returned from a Node SQLite backup operation, reporting total and remaining page counts.
 *
 * @category models
 * @since 4.0.0
 */
export interface BackupMetadata {
  readonly totalPages: number
  readonly remainingPages: number
}

/**
 * Service tag for the node SQLite client implementation.
 *
 * @category tags
 * @since 4.0.0
 */
export const SqliteClient = Context.Service<SqliteClient>("@effect/sql-sqlite-node/SqliteClient")

/**
 * Configuration for a node SQLite client backed by `better-sqlite3`, including the database filename, read-only mode, statement cache settings, WAL behavior, span attributes, and query/result name transforms.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqliteClientConfig {
  readonly filename: string
  readonly readonly?: boolean | undefined
  readonly prepareCacheSize?: number | undefined
  readonly prepareCacheTTL?: Duration.Input | undefined
  readonly disableWAL?: boolean | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined

  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly backup: (destination: string) => Effect.Effect<BackupMetadata, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

/**
 * Creates a scoped node SQLite client from the supplied configuration, using a single serialized connection with WAL enabled by default and exposing SQLite-specific `export`, `backup`, and `loadExtension` operations.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: SqliteClientConfig
): Effect.Effect<SqliteClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames ?
      Statement.defaultTransforms(
        options.transformResultNames
      ).array :
      undefined

    const makeConnection = Effect.gen(function*() {
      const scope = yield* Effect.scope
      const db = new Sqlite(options.filename, {
        readonly: options.readonly ?? false
      })
      yield* Scope.addFinalizer(scope, Effect.sync(() => db.close()))

      if (options.disableWAL !== true) {
        db.pragma("journal_mode = WAL")
      }

      const prepareCache = yield* Cache.make({
        capacity: options.prepareCacheSize ?? 200,
        timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
        lookup: (sql: string) =>
          Effect.try({
            try: () => db.prepare(sql),
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to prepare statement", "prepare") })
          })
      })

      const runStatement = (
        statement: Sqlite.Statement,
        params: ReadonlyArray<unknown>,
        raw: boolean
      ) =>
        Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
          if (Context.get(fiber.context, Client.SafeIntegers)) {
            statement.safeIntegers(true)
          }
          try {
            if (statement.reader) {
              return Effect.succeed(statement.all(...params))
            }
            const result = statement.run(...params)
            return Effect.succeed(raw ? result as unknown as ReadonlyArray<any> : [])
          } catch (cause) {
            return Effect.fail(new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }))
          }
        })

      const run = (
        sql: string,
        params: ReadonlyArray<unknown>,
        raw = false
      ) =>
        Effect.flatMap(
          Cache.get(prepareCache, sql),
          (s) => runStatement(s, params, raw)
        )

      const runValues = (
        sql: string,
        params: ReadonlyArray<unknown>
      ) =>
        Effect.acquireUseRelease(
          Cache.get(prepareCache, sql),
          (statement) =>
            Effect.try({
              try: () => {
                if (statement.reader) {
                  statement.raw(true)
                  return statement.all(...params) as ReadonlyArray<
                    ReadonlyArray<unknown>
                  >
                }
                statement.run(...params)
                return []
              },
              catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
            }),
          (statement) => Effect.sync(() => statement.reader && statement.raw(false))
        )

      return identity<SqliteConnection>({
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(run(sql, params), transformRows)
            : run(sql, params)
        },
        executeRaw(sql, params) {
          return run(sql, params, true)
        },
        executeValues(sql, params) {
          return runValues(sql, params)
        },
        executeUnprepared(sql, params, transformRows) {
          const effect = runStatement(db.prepare(sql), params ?? [], false)
          return transformRows ? Effect.map(effect, transformRows) : effect
        },
        executeStream(_sql, _params) {
          return Stream.die("executeStream not implemented")
        },
        export: Effect.try({
          try: () => db.serialize(),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to export database", "export") })
        }),
        backup(destination) {
          return Effect.tryPromise({
            try: () => db.backup(destination),
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to backup database", "backup") })
          })
        },
        loadExtension(path) {
          return Effect.try({
            try: () => db.loadExtension(path),
            catch: (cause) =>
              new SqlError({ reason: classifyError(cause, "Failed to load extension", "loadExtension") })
          })
        }
      })
    })

    const semaphore = yield* Semaphore.make(1)
    const connection = yield* makeConnection

    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(
          restore(semaphore.take(1)),
          () => Scope.addFinalizer(scope, semaphore.release(1))
        ),
        connection
      )
    })

    return Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"]
        ],
        transformRows
      })) as SqliteClient,
      {
        [TypeId]: TypeId as TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        backup: (destination: string) => Effect.flatMap(acquirer, (_) => _.backup(destination)),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path))
      }
    )
  })

/**
 * Builds a layer from an Effect `Config` value, providing both the node `SqliteClient` service and the generic `SqlClient` service.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>
): Layer.Layer<SqliteClient | Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(SqliteClient, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Builds a layer from a node SQLite client configuration, providing both `SqliteClient` and the generic `SqlClient` service.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: SqliteClientConfig
): Layer.Layer<SqliteClient | Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
