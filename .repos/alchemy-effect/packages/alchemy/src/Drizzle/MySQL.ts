// `@effect/sql-mysql2` (and mysql2 underneath) are optional peers — value
// imports are deferred to first use so `alchemy/Drizzle` resolves without
// them installed.
import type * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectMysql2Database } from "drizzle-orm/effect-mysql2";
import type { EffectDrizzleMySqlConfig } from "drizzle-orm/mysql-core/effect/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import type { MySQLConfig } from "../SQL/MySQL.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Open a Drizzle/MySQL database from a connection URL using the
 * `drizzle-orm/effect-mysql2` integration.
 *
 * ```typescript
 * const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const db = yield* Drizzle.MySQL(conn.connectionString, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The pool opens on the first query of an execution, is reused for every
 * query in it, and closes when the event settles (see
 * {@link makeExecutionMemo}); plan/deploy never connect. Workers defaults
 * ({@link resolveMySQLConfig}) are overridden via `config.client`:
 *
 * ```typescript
 * const db = yield* Drizzle.MySQL(connectionString, {
 *   relations,
 *   client: { poolConfig: { ssl: { rejectUnauthorized: true } } },
 * });
 * ```
 *
 * @binding
 */
export const MySQL = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
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
        const [MysqlClient, MySqlDrizzle, { resolveMySQLConfig }] =
          yield* Effect.promise(() =>
            Promise.all([
              import("@effect/sql-mysql2/MysqlClient"),
              import("drizzle-orm/effect-mysql2"),
              import("../SQL/MySQL.ts"),
            ]),
          );
        const { client, ...drizzleConfig } = config ?? {};
        const mysqlCtx = yield* Layer.build(
          MysqlClient.layer(
            yield* resolveMySQLConfig({ ...client, url: connectionString }),
          ),
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
