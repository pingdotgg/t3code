/**
 * ClickHouse driver for Effect SQL, backed by `@clickhouse/client`.
 *
 * Use this module to provide both the ClickHouse-specific
 * {@link ClickhouseClient} service and the generic {@link Client.SqlClient}
 * service. The client is intended for analytical application queries,
 * migrations, background jobs, bulk inserts, and streaming reads that need
 * Effect SQL query compilation, scoped lifecycle management, interruption, and
 * consistent `SqlError` classification for ClickHouse failures.
 *
 * **Mental model**
 *
 * A client owns one scoped `@clickhouse/client` instance and verifies startup
 * with `SELECT 1`. Regular queries use the ClickHouse HTTP `query` API,
 * command-mode effects use `command`, and inserts use `insert`. Interrupting an
 * operation aborts the HTTP request and attempts to kill the generated or
 * supplied `query_id`.
 *
 * **Common tasks**
 *
 * Use {@link layer} with a concrete `ClickhouseClientConfig`,
 * {@link layerConfig} when settings should come from Effect `Config`, and
 * {@link make} when a scoped client value is needed directly. Use
 * `client.param` when a placeholder needs an explicit ClickHouse type,
 * `client.asCommand` for statements that should run through `command`,
 * `client.insertQuery` for bulk inserts, and `client.withClickhouseSettings`
 * or `client.withQueryId` for per-effect request options.
 *
 * **Gotchas**
 *
 * Regular queries read JSON result sets, `executeValues` requests
 * `JSONCompact`, streams request `JSONEachRow`, and `insertQuery` defaults
 * inserts to `JSONEachRow`. The statement compiler emits typed ClickHouse
 * placeholders such as `{p1: Type}`; use `param` when the inferred type is too
 * broad. ClickHouse-specific clauses such as engines, `SETTINGS`, `FORMAT`, or
 * cluster directives must be written explicitly in SQL.
 *
 * @since 4.0.0
 */
import * as Clickhouse from "@clickhouse/client"
import * as NodeStream from "@effect/platform-node/NodeStream"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  SqlError,
  SqlSyntaxError,
  StatementTimeoutError,
  UnknownError
} from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import * as Crypto from "node:crypto"
import type { Readable } from "node:stream"

const ATTR_DB_SYSTEM_NAME = "db.system.name"
const ATTR_DB_NAMESPACE = "db.namespace"

const clickhouseCodeFromCause = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  if (typeof code === "number") {
    return code
  }
  if (typeof code === "string") {
    const parsed = Number(code)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const clickhouseSyntaxErrorCodes = new Set([36, 60, 62, 242])

const classifyError = (
  cause: unknown,
  message: string,
  operation: string,
  fallback: "connection" | "unknown" = "unknown"
) => {
  const props = { cause, message, operation }
  const code = clickhouseCodeFromCause(cause)
  if (code !== undefined) {
    if (code === 516) {
      return new AuthenticationError(props)
    }
    if (code === 497) {
      return new AuthorizationError(props)
    }
    if (clickhouseSyntaxErrorCodes.has(code)) {
      return new SqlSyntaxError(props)
    }
    if (code === 159 || code === 469) {
      return new StatementTimeoutError(props)
    }
  }
  return fallback === "connection" ? new ConnectionError(props) : new UnknownError(props)
}

/**
 * Unique runtime identifier used to tag `ClickhouseClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-clickhouse/ClickhouseClient"

/**
 * Type-level literal for the `ClickhouseClient` runtime identifier.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-clickhouse/ClickhouseClient"

/**
 * ClickHouse-specific `SqlClient` extension with access to its configuration,
 * typed parameter fragments, command-mode execution, insert queries, and
 * per-effect query ID and ClickHouse settings.
 *
 * @category models
 * @since 4.0.0
 */
export interface ClickhouseClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: ClickhouseClientConfig
  readonly param: (dataType: string, value: unknown) => Statement.Fragment
  readonly asCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly insertQuery: <T = unknown>(options: {
    readonly table: string
    readonly values: Clickhouse.InsertValues<Readable, T>
    readonly format?: Clickhouse.DataFormat
  }) => Effect.Effect<Clickhouse.InsertResult, SqlError>
  readonly withQueryId: {
    (queryId: string): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    <A, E, R>(effect: Effect.Effect<A, E, R>, queryId: string): Effect.Effect<A, E, R>
  }
  readonly withClickhouseSettings: {
    (
      settings: NonNullable<Clickhouse.BaseQueryParams["clickhouse_settings"]>
    ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      settings: NonNullable<Clickhouse.BaseQueryParams["clickhouse_settings"]>
    ): Effect.Effect<A, E, R>
  }
}

/**
 * Service tag for the active ClickHouse SQL client.
 *
 * **When to use**
 *
 * Use to access or provide a ClickHouse SQL client through the Effect context.
 *
 * @category tags
 * @since 4.0.0
 */
export const ClickhouseClient = Context.Service<ClickhouseClient>("@effect/sql-clickhouse/ClickhouseClient")

/**
 * Configuration for creating a ClickHouse client, combining
 * `@clickhouse/client` options with optional span attributes and query/result
 * name transforms.
 *
 * @category constructors
 * @since 4.0.0
 */
export interface ClickhouseClientConfig extends Clickhouse.ClickHouseClientConfigOptions {
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

/**
 * Creates a scoped `ClickhouseClient`, verifies connectivity with `SELECT 1`,
 * closes the underlying client when the scope ends, maps ClickHouse failures
 * to `SqlError`, and aborts plus kills in-flight queries when interrupted.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: ClickhouseClientConfig
): Effect.Effect<ClickhouseClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = makeCompiler(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const client = Clickhouse.createClient(options)

    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => client.exec({ query: "SELECT 1" }),
        catch: (cause) =>
          new SqlError({ reason: classifyError(cause, "ClickhouseClient: Failed to connect", "connect", "connection") })
      }),
      () => Effect.promise(() => client.close())
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        orElse: () =>
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                message: "ClickhouseClient: Connection timeout",
                cause: new Error("connection timeout"),
                operation: "connect"
              })
            })
          )
      })
    )

    class ConnectionImpl implements Connection {
      private conn: Clickhouse.ClickHouseClient
      constructor(conn: Clickhouse.ClickHouseClient) {
        this.conn = conn
      }

      private runRaw(sql: string, params: ReadonlyArray<unknown>, format: Clickhouse.DataFormat = "JSON") {
        const paramsObj: Record<string, unknown> = {}
        for (let i = 0; i < params.length; i++) {
          paramsObj[`p${i + 1}`] = params[i]
        }
        return Effect.withFiber<Clickhouse.ResultSet<"JSON"> | Clickhouse.CommandResult, SqlError>((fiber) => {
          const method = fiber.getRef(ClientMethod)
          return Effect.callback<Clickhouse.ResultSet<"JSON"> | Clickhouse.CommandResult, SqlError>((resume) => {
            const queryId = fiber.getRef(QueryId) ?? Crypto.randomUUID()
            const settings = fiber.getRef(ClickhouseSettings)
            const controller = new AbortController()
            if (method === "command") {
              this.conn.command({
                query: sql,
                query_params: paramsObj,
                abort_signal: controller.signal,
                query_id: queryId,
                clickhouse_settings: settings
              }).then(
                (result) => resume(Effect.succeed(result)),
                (cause) =>
                  resume(
                    Effect.fail(
                      new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
                    )
                  )
              )
            } else {
              this.conn.query({
                query: sql,
                query_params: paramsObj,
                abort_signal: controller.signal,
                query_id: queryId,
                clickhouse_settings: settings,
                format
              }).then(
                (result) => resume(Effect.succeed(result)),
                (cause) =>
                  resume(
                    Effect.fail(
                      new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") })
                    )
                  )
              )
            }
            return Effect.suspend(() => {
              controller.abort()
              return Effect.promise(() => this.conn.command({ query: `KILL QUERY WHERE query_id = '${queryId}'` }))
            })
          })
        })
      }

      private run(sql: string, params: ReadonlyArray<unknown>, format?: Clickhouse.DataFormat) {
        return this.runRaw(sql, params, format).pipe(
          Effect.flatMap((result) => {
            if ("json" in result) {
              return Effect.promise(() =>
                result.json().then(
                  (result) => "data" in result ? result.data : result as any,
                  () => []
                )
              )
            }
            return Effect.succeed([])
          })
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
        return this.run(sql, params, "JSONCompact")
      }
      executeUnprepared(sql: string, params: ReadonlyArray<unknown>, transformRows?: any) {
        return this.execute(sql, params, transformRows)
      }
      executeStream(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
      ) {
        return this.runRaw(sql, params, "JSONEachRow").pipe(
          Effect.map((result) => {
            if (!("stream" in result)) {
              return Stream.empty
            }
            return NodeStream.fromReadable<ReadonlyArray<Clickhouse.Row<any, "JSONEachRow">>, SqlError>({
              evaluate: () => result.stream() as any,
              onError: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute stream", "stream") })
            })
          }),
          Stream.unwrap,
          Stream.chunks,
          Stream.mapEffect((chunk) => {
            const promises: Array<Promise<any>> = []
            for (const rows of chunk) {
              for (const row of rows) {
                promises.push(row.json())
              }
            }
            return Effect.tryPromise({
              try: () => Promise.all(promises).then((rows) => transformRows ? transformRows(rows) : rows),
              catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to parse row", "parseRow") })
            })
          }),
          Stream.flattenIterable
        )
      }
    }

    const connection = new ConnectionImpl(client)

    return Object.assign(
      yield* Client.make({
        acquirer: Effect.succeed(connection),
        compiler,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "clickhouse"],
          [ATTR_DB_NAMESPACE, options.database ?? "default"]
        ],
        beginTransaction: "BEGIN TRANSACTION",
        transformRows
      }),
      {
        [TypeId]: TypeId as TypeId,
        config: options,
        param(dataType: string, value: unknown) {
          return Statement.fragment([clickhouseParam(dataType, value)])
        },
        asCommand<A, E, R>(effect: Effect.Effect<A, E, R>) {
          return Effect.provideService(effect, ClientMethod, "command")
        },
        insertQuery<T = unknown>(options: {
          readonly table: string
          readonly values: Clickhouse.InsertValues<Readable, T>
          readonly format?: Clickhouse.DataFormat
        }) {
          return Effect.callback<Clickhouse.InsertResult, SqlError>((resume) => {
            const fiber = Fiber.getCurrent()!
            const queryId = fiber.getRef(QueryId) ?? Crypto.randomUUID()
            const settings = fiber.getRef(ClickhouseSettings)
            const controller = new AbortController()
            client.insert({
              format: "JSONEachRow",
              ...options,
              abort_signal: controller.signal,
              query_id: queryId,
              clickhouse_settings: settings
            }).then(
              (result) => resume(Effect.succeed(result)),
              (cause) =>
                resume(Effect.fail(new SqlError({ reason: classifyError(cause, "Failed to insert data", "insert") })))
            )
            return Effect.suspend(() => {
              controller.abort()
              return Effect.promise(() => client.command({ query: `KILL QUERY WHERE query_id = '${queryId}'` }))
            })
          })
        },
        withQueryId: dual(
          2,
          <A, E, R>(effect: Effect.Effect<A, E, R>, queryId: string) => Effect.provideService(effect, QueryId, queryId)
        ),
        withClickhouseSettings: dual(
          2,
          <A, E, R>(
            effect: Effect.Effect<A, E, R>,
            settings: NonNullable<Clickhouse.BaseQueryParams["clickhouse_settings"]>
          ) => Effect.provideService(effect, ClickhouseSettings, settings)
        )
      }
    )
  })

/**
 * Fiber reference read by the low-level ClickHouse connection to choose query
 * or command execution for statements; defaults to `query`.
 *
 * @category references
 * @since 4.0.0
 */
export const ClientMethod = Context.Reference<"query" | "command" | "insert">(
  "@effect/sql-clickhouse/ClickhouseClient/ClientMethod",
  {
    defaultValue: () => "query"
  }
)

/**
 * Fiber reference for the ClickHouse `query_id` applied to queries and
 * inserts; a random UUID is generated when no query ID is set.
 *
 * @category references
 * @since 4.0.0
 */
export const QueryId = Context.Reference<string | undefined>(
  "@effect/sql-clickhouse/ClickhouseClient/QueryId",
  { defaultValue: () => undefined }
)

/**
 * Fiber reference containing ClickHouse settings to attach to queries,
 * commands, and inserts.
 *
 * @category references
 * @since 4.0.0
 */
export const ClickhouseSettings: Context.Reference<
  NonNullable<Clickhouse.BaseQueryParams["clickhouse_settings"]>
> = Context.Reference("@effect/sql-clickhouse/ClickhouseClient/ClickhouseSettings", {
  defaultValue: () => ({})
})

/**
 * Provides both `ClickhouseClient` and generic `SqlClient` services from a
 * `Config`-backed ClickHouse client configuration.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig: (
  config: Config.Wrap<ClickhouseClientConfig>
) => Layer.Layer<ClickhouseClient | Client.SqlClient, Config.ConfigError | SqlError> = (
  config: Config.Wrap<ClickhouseClientConfig>
): Layer.Layer<ClickhouseClient | Client.SqlClient, Config.ConfigError | SqlError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(ClickhouseClient, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Provides both `ClickhouseClient` and generic `SqlClient` services from a
 * ClickHouse client configuration.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: ClickhouseClientConfig
): Layer.Layer<ClickhouseClient | Client.SqlClient, Config.ConfigError | SqlError> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(ClickhouseClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))

const typeFromUnknown = (value: unknown): string => {
  if (Statement.isFragment(value)) {
    return typeFromUnknown(value.segments[0])
  } else if (isClickhouseParam(value)) {
    return value.paramA
  } else if (Array.isArray(value)) {
    return `Array(${typeFromUnknown(value[0])})`
  }
  switch (typeof value) {
    case "number":
      return "Decimal"
    case "bigint":
      return "Int64"
    case "boolean":
      return "Bool"
    case "object":
      if (value instanceof Date) {
        return "DateTime()"
      }
      return "String"
    default:
      return "String"
  }
}

/**
 * Creates the SQL statement compiler for ClickHouse, emitting typed
 * `{pN: Type}` placeholders and escaping identifiers with an optional query
 * name transform.
 *
 * @category compiler
 * @since 4.0.0
 */
export const makeCompiler = (transform?: (_: string) => string) =>
  Statement.makeCompiler<ClickhouseCustom>({
    dialect: "sqlite",
    placeholder(i, u) {
      return `{p${i}: ${typeFromUnknown(u)}}`
    },
    onIdentifier: transform ?
      function(value, withoutTransform) {
        return withoutTransform ? escape(value) : escape(transform(value))
      } :
      escape,
    onRecordUpdate() {
      return ["", []]
    },
    onCustom(type, placeholder) {
      return [placeholder(type), [type.paramB]]
    }
  })

// compiler helpers

const escape = Statement.defaultEscape("\"")

/**
 * Custom SQL fragment type used for ClickHouse typed parameters created by
 * `ClickhouseClient.param`.
 *
 * @category custom types
 * @since 4.0.0
 */
export type ClickhouseCustom = ClickhouseParam

/**
 * @category custom types
 * @since 4.0.0
 */
interface ClickhouseParam extends Statement.Custom<"ClickhouseParam", string, unknown> {}

const clickhouseParam = Statement.custom<ClickhouseParam>("ClickhouseParam")
const isClickhouseParam = Statement.isCustom<ClickhouseParam>("ClickhouseParam")
