import {
  resolveConnectionSource,
  staticConnectionSource,
  type ConnectionSource,
} from "alchemy/SQL/ConnectionSource";
import { openMySQLPool } from "alchemy/SQL/MySQLDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { PoolOptions } from "mysql2/promise";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import { makeMigrateSupport, type SqlLayerOptions } from "./Postgres.ts";

export interface MySQLOptions extends SqlLayerOptions {
  readonly pool?: Omit<PoolOptions, "uri">;
}

/**
 * Build the MySQL {@link DatabaseService}. Better Auth's Kysely path
 * expects the `mysql2/promise` pool: it passes the pool itself as the
 * MysqlDialect config, and the promise pool's `.pool` property is the
 * callback pool Kysely drives.
 *
 * @internal
 */
export const makeMySQLService = (
  source: ConnectionSource,
  options: MySQLOptions | undefined,
): Effect.Effect<DatabaseService> =>
  Effect.gen(function* () {
    const urlEffect = yield* resolveConnectionSource(source);
    const migrateSource = staticConnectionSource(source, options?.migrate);
    const open = (url: Effect.Effect<Redacted.Redacted<string>>) =>
      openMySQLPool(url, options?.pool) as unknown as Effect.Effect<
        DirectDatabase,
        never,
        Scope.Scope
      >;

    return {
      provider: "mysql",
      runtime: open(urlEffect) as DatabaseService["runtime"],
      ...(migrateSource === undefined
        ? {}
        : {
            migrate: makeMigrateSupport(
              migrateSource,
              open,
              "Failed to load `mysql2` — install it to migrate a MySQL-backed BetterAuth",
            ),
          }),
    } satisfies DatabaseService;
  }) as Effect.Effect<DatabaseService>;

/**
 * Generic TCP MySQL database layer for Better Auth, from a connection
 * string.
 *
 * Works with PlanetScale MySQL, Cloudflare Hyperdrive MySQL origins, AWS
 * RDS MySQL, or any literal URL. One `mysql2` pool per execution, closed
 * when the event settles.
 *
 *
 * ### Connecting to PlanetScale MySQL
 * PlanetScale requires TLS — pass it in the URL's `ssl` query parameter
 * (mysql2 parses it as JSON).
 * **Example:** PlanetScale MySQL with TLS
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { MySQL } from "@alchemy.run/better-auth/MySQL";
 *
 * const password = yield* Planetscale.MySQLPassword("auth-db", {
 *   database,
 *   role: "admin",
 * });
 * const url =
 *   `mysql://${password.username}:...@${password.host}/${database.name}` +
 *   `?ssl=${encodeURIComponent('{"rejectUnauthorized":true}')}`;
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(Effect.provide(MySQL(url)))
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer mysql2
 * @product MySQL
 */
export const MySQL = (
  url: ConnectionSource,
  options?: MySQLOptions,
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    makeMySQLService(url, options),
  ) as Layer.Layer<Database>;
