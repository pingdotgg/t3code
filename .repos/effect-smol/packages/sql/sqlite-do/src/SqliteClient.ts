/**
 * Connects Effect SQL to SQLite storage inside Cloudflare Durable Objects.
 *
 * This module adapts a Durable Object `SqlStorage` handle into both the
 * Durable Object-specific `SqliteClient` service and the generic Effect
 * `SqlClient` service. Use it from inside a Durable Object to run local
 * per-object queries, repositories, migrations, transactional read/write
 * workflows, and tests that exercise Cloudflare's SQLite-backed storage API.
 *
 * Durable Object SQLite storage is scoped to one object id, so each object
 * instance has its own database. Callers can pass the `SqlStorage` handle for
 * normal queries, or the full `DurableObjectStorage` when `withTransaction` or
 * migrations need Cloudflare-managed transactions. This adapter serializes
 * Effect SQL access through one connection; a transaction holds that permit for
 * the lifetime of its scope, so keep transactions short, avoid suspending them
 * across unrelated work, and use them when multi-statement writes must commit
 * atomically. `SqlStorage.exec` returns `ArrayBuffer` values
 * for SQLite blobs, which this client normalizes to `Uint8Array`, and SQLite
 * does not support `updateValues`.
 *
 * @since 4.0.0
 */
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Rec from "effect/Record"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(cause, { message, operation })

/**
 * Runtime type identifier used to mark Cloudflare Durable Object `SqliteClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-sqlite-do/SqliteClient"

/**
 * Type-level identifier used to mark Cloudflare Durable Object `SqliteClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-sqlite-do/SqliteClient"

/**
 * Cloudflare Durable Object SQLite client service, extending `SqlClient` with its configuration. `updateValues` is not supported.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: SqliteClientConfig

  /** Not supported in sqlite */
  readonly updateValues: never
}

/**
 * Service tag for the Cloudflare Durable Object SQLite client service.
 *
 * **When to use**
 *
 * Use to access or provide a Durable Object SQLite client through the Effect
 * context.
 *
 * @category services
 * @since 4.0.0
 */
export const SqliteClient = Context.Service<SqliteClient>("@effect/sql-sqlite-do/SqliteClient")

const SqliteTransaction = Context.Service<Client.TransactionConnection, Client.TransactionConnection.Service>(
  "@effect/sql-sqlite-do/SqliteClient/SqliteTransaction"
)

/**
 * Configuration for a Cloudflare Durable Object SQLite client, including either a `SqlStorage` handle or the full `DurableObjectStorage` for transaction support, span attributes, and query/result name transforms.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqliteClientConfig {
  readonly db?: SqlStorage | undefined
  readonly storage?: DurableObjectStorage | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined

  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

const unsupportedTransaction = (message: string, operation: string) =>
  new SqlError({
    reason: new UnknownError({
      cause: new Error(message),
      message,
      operation
    })
  })

const makeUnsupportedWithTransaction =
  (message: string): Client.SqlClient["withTransaction"] =>
  <R, E, A>(_effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    Effect.fail(unsupportedTransaction(message, "transaction"))

const makeStorageBackedWithTransaction = (
  storage: DurableObjectStorage,
  connection: Connection,
  semaphore: Semaphore.Semaphore
): Client.SqlClient["withTransaction"] =>
<R, E, A>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
  Effect.withFiber((fiber) => {
    const services = fiber.context
    const connOption = Context.getOption(services, SqliteTransaction)
    if (connOption._tag === "Some") {
      return Effect.fail(
        unsupportedTransaction(
          "Nested transactions are not supported by Cloudflare Durable Object SQLite storage",
          "transaction"
        )
      )
    }

    const effectWithTxn = Effect.provideContext(
      effect,
      Context.add(services, SqliteTransaction, [connection, 0] as const)
    )

    return semaphore.withPermits(1)(
      Effect.callback((resume) => {
        let interrupted = false
        const promise = storage.transaction((txn) =>
          new Promise<void>((resolve) => {
            if (interrupted) return resolve()
            resume(Effect.onExit(effectWithTxn, (exit) => {
              if (Exit.isFailure(exit)) {
                txn.rollback()
              }
              resolve()
              // wait for the transaction to complete
              return Effect.promise(() => promise)
            }))
          })
        ).catch((cause) =>
          resume(Effect.fail(new SqlError({ reason: classifyError(cause, "Failed transaction", "transaction") })))
        )
        return Effect.suspend(() => {
          interrupted = true
          return Effect.promise(() => promise)
        })
      })
    )
  })

/**
 * Creates a scoped Cloudflare Durable Object SQLite client around Durable Object SQLite storage, serializing access and converting returned `ArrayBuffer` values to `Uint8Array`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: SqliteClientConfig
): Effect.Effect<SqliteClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined
    const db = options.storage?.sql ?? options.db

    if (db === undefined) {
      return yield* Effect.die("SqliteClient.make requires either a Durable Object storage or sql storage")
    }
    const sqlStorage = db

    const makeConnection = Effect.gen(function*() {
      function* runIterator(
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) {
        const cursor = sqlStorage.exec(sql, ...params)
        const columns = cursor.columnNames
        for (const result of cursor.raw()) {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) {
            const value = result[i]
            Rec.assignProperty(obj, columns[i], value instanceof ArrayBuffer ? new Uint8Array(value) : value)
          }
          yield obj
        }
      }

      const runStatement = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ): Effect.Effect<ReadonlyArray<any>, SqlError, never> =>
        Effect.try({
          try: () => Array.from(runIterator(sql, params)),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
        })

      const runValues = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ): Effect.Effect<ReadonlyArray<any>, SqlError, never> =>
        Effect.try({
          try: () =>
            Array.from(sqlStorage.exec(sql, ...params).raw(), (row) => {
              for (let i = 0; i < row.length; i++) {
                const value = row[i]
                if (value instanceof ArrayBuffer) {
                  row[i] = new Uint8Array(value) as any
                }
              }
              return row
            }),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
        })

      return identity<Connection>({
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(runStatement(sql, params), transformRows)
            : runStatement(sql, params)
        },
        executeRaw(sql, params) {
          return runStatement(sql, params)
        },
        executeValues(sql, params) {
          return runValues(sql, params)
        },
        executeValuesUnprepared(sql, params) {
          return runValues(sql, params)
        },
        executeUnprepared(sql, params, transformRows) {
          return transformRows
            ? Effect.map(runStatement(sql, params), transformRows)
            : runStatement(sql, params)
        },
        executeStream(sql, params, transformRows) {
          return Stream.suspend(() => {
            const iterator = runIterator(sql, params)
            return Stream.fromIteratorSucceed(iterator, 128)
          }).pipe(
            transformRows
              ? Stream.mapArray((chunk) => transformRows(chunk) as any)
              : identity
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

    const client = (yield* Client.make({
      acquirer,
      compiler,
      transactionAcquirer,
      transactionService: SqliteTransaction,
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        [ATTR_DB_SYSTEM_NAME, "sqlite"]
      ],
      transformRows
    })) as SqliteClient

    return Object.assign(client, {
      [TypeId]: TypeId as TypeId,
      config: options,
      withTransaction: options.storage
        ? makeStorageBackedWithTransaction(options.storage, connection, semaphore)
        : makeUnsupportedWithTransaction(
          "Transactions require Durable Object storage; pass ctx.storage as the storage option"
        )
    })
  })

/**
 * Creates a layer from a `Config`-wrapped Durable Object SQLite client configuration, providing both `SqliteClient` and `SqlClient`.
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
 * Creates a layer from a concrete Durable Object SQLite client configuration, providing both `SqliteClient` and `SqlClient`.
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
