// @effect-diagnostics anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off preferSchemaOverJson:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off - vendored alchemy code, kept verbatim; alchemy owns these idioms.
// Vendored from alchemy-run/alchemy#1063 (src/SQL/MySQL.ts + src/Drizzle/MySQL.ts,
// merge commit 5ae3df20df): Drizzle.MySQL landed upstream after alchemy
// 2.0.0-beta.67 was cut, so no published release carries it yet. Delete this
// file and import `Drizzle.MySQL` from "alchemy/Drizzle" once the workspace
// moves to a release that contains it.
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { proxyChain } from "alchemy/Util/proxy-chain";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectMysql2Database } from "drizzle-orm/effect-mysql2";
import * as MySqlDrizzle from "drizzle-orm/effect-mysql2";
import type { EffectDrizzleMySqlConfig } from "drizzle-orm/mysql-core/effect/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Options for the MySQL client: `@effect/sql-mysql2`'s client configuration,
 * with `url` widened to also accept an Effect (e.g. a Hyperdrive connection
 * string, which resolves from the Worker environment at runtime).
 */
export type MySQLConfig<E = never, R = never> = Omit<MysqlClient.MysqlClientConfig, "url"> & {
  readonly url: Redacted.Redacted<string> | Effect.Effect<Redacted.Redacted<string>, E, R>;
};

const isWorkerd = () =>
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
    "Cloudflare-Workers" || "WebSocketPair" in globalThis;

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
        username: u.username === "" ? undefined : decodeURIComponent(u.username),
        password: u.password === "" ? undefined : Redacted.make(decodeURIComponent(u.password)),
        poolConfig: poolConfig as MysqlClient.MysqlClientConfig["poolConfig"],
      };
    },
    catch: (cause) => new Error(`SQL.MySQL: failed to parse connection url: ${cause}`),
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
 * Open a Drizzle/MySQL database from a connection URL using the
 * `drizzle-orm/effect-mysql2` integration.
 *
 * ```typescript
 * const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const db = yield* DrizzleMysql.MySQL(conn.connectionString, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The pool opens on the first query of an execution, is reused for every
 * query in it, and closes when the event settles (see
 * {@link makeExecutionMemo}); plan/deploy never connect. Workers defaults
 * ({@link resolveMySQLConfig}) are overridden via `config.client`.
 *
 * @binding
 */
export const MySQL = <TRelations extends AnyRelations = EmptyRelations, E = never, R = never>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: EffectDrizzleMySqlConfig<TRelations> & {
    /**
     * Overrides for the underlying `@effect/sql-mysql2` client — pool
     * options (e.g. `poolConfig.ssl` for a direct TLS connection),
     * `disablePreparedStatements`, `maxConnections`, and friends.
     */
    readonly client?: Omit<MySQLConfig, "url">;
  },
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const { client, ...drizzleConfig } = config ?? {};
        const mysqlCtx = yield* Layer.build(
          MysqlClient.layer(yield* resolveMySQLConfig({ ...client, url: connectionString })),
        );
        return yield* MySqlDrizzle.makeWithDefaults(
          drizzleConfig as EffectDrizzleMySqlConfig<TRelations>,
        ).pipe(Effect.provideContext(mysqlCtx));
      }),
    ),
    (db) =>
      proxyChain<
        EffectMysql2Database<TRelations> & {
          $client: MysqlClient.MysqlClient;
        }
      >(
        db as Effect.Effect<
          EffectMysql2Database<TRelations> & {
            $client: MysqlClient.MysqlClient;
          }
        >,
      ),
  );
