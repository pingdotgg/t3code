/**
 * Connects Effect SQL to SQLite on Node.js using `node:sqlite`.
 *
 * This module opens a SQLite database and exposes it as both `SqliteClient` and
 * the generic Effect SQL client. It serializes access through one connection,
 * caches prepared statements, enables WAL mode unless disabled, and supports
 * database backup, and extension loading. Streaming queries and
 * `updateValues` are not supported by this driver.
 *
 * @since 4.0.0
 */
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
import { backup as backupDatabase, DatabaseSync } from "node:sqlite"
import type { StatementSync } from "node:sqlite"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

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
 * @category services
 * @since 4.0.0
 */
export const SqliteClient = Context.Service<SqliteClient>("@effect/sql-sqlite-node/SqliteClient")

/**
 * Configuration for a node SQLite client backed by `node:sqlite`, including the database filename, read-only mode, statement cache settings, WAL behavior, span attributes, and query/result name transforms.
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
      const db = new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: true
      })
      yield* Scope.addFinalizer(scope, Effect.sync(() => db.close()))
      db.enableLoadExtension(false)

      if (options.disableWAL !== true) {
        db.exec("PRAGMA journal_mode = WAL")
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
        statement: StatementSync,
        params: ReadonlyArray<unknown>,
        raw: boolean
      ) =>
        Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
          const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers)
          return Effect.try({
            try: () => {
              statement.setReadBigInts(useSafeIntegers)
              if (statement.columns().length > 0) {
                return statement.all(...(params as Array<any>)) as ReadonlyArray<any>
              }
              const result = statement.run(...(params as Array<any>))
              return raw ? { changes: result.changes, lastInsertRowid: result.lastInsertRowid } as any : []
            },
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
          })
        })

      const runStatementValues = (
        statement: StatementSync,
        params: ReadonlyArray<unknown>
      ) =>
        Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
          const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers)
          return Effect.try({
            try: () => {
              statement.setReadBigInts(useSafeIntegers)
              if (statement.columns().length > 0) {
                return statement.all(...(params as Array<any>)) as unknown as ReadonlyArray<ReadonlyArray<unknown>>
              }
              statement.run(...(params as Array<any>))
              return []
            },
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
          })
        })

      const runStatementValuesUnprepared = (
        statement: StatementSync,
        params: ReadonlyArray<unknown>
      ) =>
        Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
          const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers)
          return Effect.try({
            try: () => {
              statement.setReadBigInts(useSafeIntegers)
              statement.setReturnArrays(true)
              if (statement.columns().length > 0) {
                return statement.all(...(params as Array<any>)) as unknown as ReadonlyArray<ReadonlyArray<unknown>>
              }
              statement.run(...(params as Array<any>))
              return []
            },
            catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
          })
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
          (statement) => {
            statement.setReturnArrays(true)
            return runStatementValues(statement, params)
          },
          (statement) => Effect.sync(() => statement.setReturnArrays(false))
        )

      const runValuesUnprepared = (
        sql: string,
        params: ReadonlyArray<unknown>
      ) => runStatementValuesUnprepared(db.prepare(sql), params)

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
        executeValuesUnprepared(sql, params) {
          return runValuesUnprepared(sql, params)
        },
        executeUnprepared(sql, params, transformRows) {
          const effect = runStatement(db.prepare(sql), params ?? [], false)
          return transformRows ? Effect.map(effect, transformRows) : effect
        },
        executeStream(_sql, _params) {
          return Stream.die("executeStream not implemented")
        },
        backup(destination) {
          return Effect.suspend(() => {
            let totalPages = 0
            return Effect.tryPromise({
              try: () =>
                backupDatabase(db, destination, {
                  progress: (progress) => {
                    totalPages = progress.totalPages
                  }
                }).then((pages): BackupMetadata => ({ totalPages: totalPages || pages, remainingPages: 0 })),
              catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to backup database", "backup") })
            })
          })
        },
        loadExtension(path) {
          return Effect.acquireUseRelease(
            Effect.sync(() => db.enableLoadExtension(true)),
            () =>
              Effect.try({
                try: () => db.loadExtension(path),
                catch: (cause) =>
                  new SqlError({ reason: classifyError(cause, "Failed to load extension", "loadExtension") })
              }),
            () => Effect.sync(() => db.enableLoadExtension(false))
          )
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

// internal

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(sqliteCauseWithErrno(cause), { message, operation })

const sqliteCauseWithErrno = (cause: unknown): unknown => {
  if (typeof cause !== "object" || cause === null || !("errcode" in cause) || "errno" in cause) {
    return cause
  }
  const errcode = (cause as { readonly errcode: unknown }).errcode
  if (typeof errcode !== "number") {
    return cause
  }
  return Object.assign(cause, { errno: errcode })
}
