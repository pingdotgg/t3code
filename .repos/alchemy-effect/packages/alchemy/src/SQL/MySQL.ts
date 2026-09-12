import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import type * as Mysql from "mysql2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Sql from "effect/unstable/sql/SqlClient";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Options for {@link MySQL}: `@effect/sql-mysql2`'s client configuration,
 * with `url` widened to also accept an Effect (e.g. a Hyperdrive connection
 * string, which resolves from the Worker environment at runtime).
 */
export type MySQLConfig<E = never, R = never> = Omit<
  MysqlClient.MysqlClientConfig,
  "url"
> & {
  readonly url:
    | Redacted.Redacted<string>
    | Effect.Effect<Redacted.Redacted<string>, E, R>;
};

const isWorkerd = () =>
  (globalThis as { navigator?: { userAgent?: string } }).navigator
    ?.userAgent === "Cloudflare-Workers" || "WebSocketPair" in globalThis;

// Query-string params are JSON-parsed into poolConfig entries (mysql2's own
// URI convention), so `mysql://...?ssl={"rejectUnauthorized":true}` works.
const parseMySQLUrl = (url: Redacted.Redacted<string>) =>
  Effect.try({
    try: () => {
      const u = new URL(Redacted.value(url));
      const poolConfig: Record<string, unknown> = {};
      for (const [key, value] of u.searchParams) {
        try {
          poolConfig[key] = JSON.parse(value);
        } catch {
          poolConfig[key] = value;
        }
      }
      const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
      return {
        host: u.hostname,
        port: u.port === "" ? 3306 : Number(u.port),
        database: database === "" ? undefined : database,
        username:
          u.username === "" ? undefined : decodeURIComponent(u.username),
        password:
          u.password === ""
            ? undefined
            : Redacted.make(decodeURIComponent(u.password)),
        poolConfig: poolConfig as Mysql.PoolOptions,
      };
    },
    catch: (cause) =>
      new Error(`SQL.MySQL: failed to parse connection url: ${cause}`),
  }).pipe(Effect.orDie);

/**
 * Resolve a {@link MySQLConfig} into the `MysqlClientConfig` handed to
 * `@effect/sql-mysql2`. The `url` is parsed into discrete connection fields
 * (mysql2's URI code path ignores `poolConfig`), and on workerd the defaults
 * flip to `poolConfig.disableEval` (no runtime codegen in the isolate) and
 * `disablePreparedStatements` (Hyperdrive's MySQL proxy has no
 * `COM_STMT_PREPARE`). Explicit config fields always win over parsed /
 * detected values.
 */
export const resolveMySQLConfig = <E = never, R = never>(
  config: MySQLConfig<E, R>,
): Effect.Effect<MysqlClient.MysqlClientConfig, E, R> =>
  Effect.gen(function* () {
    const { url, ...overrides } = config;
    const resolved = Effect.isEffect(url) ? yield* url : url;
    const parsed = yield* parseMySQLUrl(resolved);
    const workerd = yield* Effect.sync(isWorkerd);
    return {
      ...overrides,
      host: overrides.host ?? parsed.host,
      port: overrides.port ?? parsed.port,
      database: overrides.database ?? parsed.database,
      username: overrides.username ?? parsed.username,
      password: overrides.password ?? parsed.password,
      poolConfig: {
        ...(workerd ? { disableEval: true } : {}),
        ...parsed.poolConfig,
        ...overrides.poolConfig,
      },
      disablePreparedStatements: overrides.disablePreparedStatements ?? workerd,
    } satisfies MysqlClient.MysqlClientConfig;
  });

/**
 * Open an `@effect/sql-mysql2` client (a connection pool) from a connection
 * URL — a plain `Redacted` or an Effect of one, e.g. Hyperdrive's
 * `connectionString`:
 *
 * ```typescript
 * import * as SQL from "alchemy/SQL/MySQL";
 *
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const sql = yield* SQL.MySQL({ url: hd.connectionString });
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * The pool opens on the first query of an execution, is reused for every
 * query in it, and closes when the event settles (see
 * {@link makeExecutionMemo}); plan/deploy never connect. Workers defaults
 * ({@link resolveMySQLConfig}) are overridden in the config:
 *
 * ```typescript
 * const sql = yield* SQL.MySQL({
 *   url,
 *   disablePreparedStatements: true,
 *   poolConfig: { ssl: { rejectUnauthorized: true } },
 * });
 * ```
 *
 * @binding
 */
export const MySQL = <E = never, R = never>(config: MySQLConfig<E, R>) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const resolved = yield* resolveMySQLConfig(config);
        const mysqlCtx = yield* Layer.build(MysqlClient.layer(resolved));
        return Context.get(mysqlCtx, MysqlClient.MysqlClient);
      }),
    ),
    (client) => proxyChain<MysqlClient.MysqlClient>(client),
  );

/**
 * Provide an `@effect/sql-mysql2` client as the `MysqlClient` and generic
 * `SqlClient` services:
 *
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const app = yield* makeApp.pipe(
 *   Effect.provide(SQL.MySQLLayer({ url: hd.connectionString })),
 * );
 * ```
 *
 * The layer itself builds synchronously at init; the underlying pool is
 * created lazily per execution (see {@link MySQL}).
 */
export const MySQLLayer = <E = never, R = never>(config: MySQLConfig<E, R>) =>
  // Derive SqlClient from the single MysqlClient build so both tags share
  // one per-execution pool.
  Layer.effect(
    Sql.SqlClient,
    Effect.gen(function* () {
      return yield* MysqlClient.MysqlClient;
    }),
  ).pipe(
    Layer.provideMerge(Layer.effect(MysqlClient.MysqlClient, MySQL(config))),
  );
