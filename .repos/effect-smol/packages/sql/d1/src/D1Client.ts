/**
 * Cloudflare D1 client implementation for Effect SQL, backed by a Workers `D1Database` binding.
 *
 * This module adapts a Cloudflare D1 database binding into both the
 * D1-specific `D1Client` service and the generic Effect `SqlClient` service.
 * It uses the SQLite statement compiler, caches prepared statements, maps D1
 * failures to `SqlError`, and provides direct or config-backed layers.
 * Transactions, streaming queries, and `updateValues` are not supported by this
 * driver.
 *
 * @since 4.0.0
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import * as Cache from "effect/Cache"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const classifyError = (cause: unknown, message: string, operation: string) =>
  new UnknownError({ cause, message, operation })

/**
 * Unique runtime identifier used to tag `D1Client` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-d1/D1Client"

/**
 * Type-level literal for the `D1Client` runtime identifier.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-d1/D1Client"

/**
 * Cloudflare D1 SQL client service, extending `SqlClient` with its D1 configuration and no `updateValues` support.
 *
 * @category models
 * @since 4.0.0
 */
export interface D1Client extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: D1ClientConfig

  /** Not supported in d1 */
  readonly updateValues: never
}

/**
 * Service tag for the Cloudflare D1 SQL client.
 *
 * **When to use**
 *
 * Use to access or provide a Cloudflare D1 SQL client through the Effect
 * context.
 *
 * @category services
 * @since 4.0.0
 */
export const D1Client = Context.Service<D1Client>("@effect/sql-d1/D1Client")

/**
 * Configuration for a Cloudflare D1 client, including the `D1Database`, prepared statement cache settings, span attributes, and query/result name transforms.
 *
 * @category models
 * @since 4.0.0
 */
export interface D1ClientConfig {
  readonly db: D1Database
  readonly prepareCacheSize?: number | undefined
  readonly prepareCacheTTL?: Duration.Input | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined

  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

/**
 * Creates a scoped Cloudflare D1 SQL client. Prepared statements are cached, while transactions and streaming queries are not supported by this driver.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: D1ClientConfig
): Effect.Effect<D1Client, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames ?
      Statement.defaultTransforms(options.transformResultNames).array :
      undefined

    const makeConnection = Effect.gen(function*() {
      const db = options.db

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
        statement: D1PreparedStatement,
        params: ReadonlyArray<unknown> = []
      ): Effect.Effect<ReadonlyArray<any>, SqlError, never> =>
        Effect.tryPromise({
          try: async () => {
            const response = await statement.bind(...params).all()
            if (response.error) {
              throw response.error
            }
            return response.results || []
          },
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
        })

      const runRaw = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) => runStatement(db.prepare(sql), params)

      const runCached = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) => Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params))

      const runUncached = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) => runRaw(sql, params)

      const runValues = (
        sql: string,
        params: ReadonlyArray<unknown>
      ) =>
        Effect.flatMap(
          Cache.get(prepareCache, sql),
          (statement) =>
            Effect.tryPromise({
              try: () => {
                return statement.bind(...params).raw() as Promise<
                  ReadonlyArray<
                    ReadonlyArray<unknown>
                  >
                >
              },
              catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
            })
        )

      const runValuesUncached = (
        sql: string,
        params: ReadonlyArray<unknown>
      ) =>
        Effect.tryPromise({
          try: () => {
            return db.prepare(sql).bind(...params).raw() as Promise<
              ReadonlyArray<
                ReadonlyArray<unknown>
              >
            >
          },
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
        })

      return identity<Connection>({
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(runCached(sql, params), transformRows)
            : runCached(sql, params)
        },
        executeRaw(sql, params) {
          return runRaw(sql, params)
        },
        executeValues(sql, params) {
          return runValues(sql, params)
        },
        executeValuesUnprepared(sql, params) {
          return runValuesUncached(sql, params)
        },
        executeUnprepared(sql, params, transformRows) {
          return transformRows
            ? Effect.map(runUncached(sql, params), transformRows)
            : runUncached(sql, params)
        },
        executeStream(_sql, _params) {
          return Stream.die("executeStream not implemented")
        }
      })
    })

    const connection = yield* makeConnection
    const acquirer = Effect.succeed(connection)
    const transactionAcquirer = Effect.die("transactions are not supported in D1")

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
      })) as D1Client,
      {
        [TypeId]: TypeId as TypeId,
        config: options
      }
    )
  })

/**
 * Creates a layer from a `Config`-wrapped D1 client configuration, providing both `D1Client` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  config: Config.Wrap<D1ClientConfig>
): Layer.Layer<D1Client | Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(D1Client, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Creates a layer from a concrete D1 client configuration, providing both `D1Client` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: D1ClientConfig
): Layer.Layer<D1Client | Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(D1Client, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
