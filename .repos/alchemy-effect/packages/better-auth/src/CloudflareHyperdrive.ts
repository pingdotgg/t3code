import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { Database } from "./Database.ts";
import { makeMySQLService, type MySQLOptions } from "./MySQL.ts";
import {
  makePostgresService,
  type MigrateSource,
  type PostgresOptions,
} from "./Postgres.ts";

export interface CloudflareHyperdriveOptions {
  /**
   * Origin dialect behind the Hyperdrive connection.
   * @default "postgres"
   */
  readonly dialect?: "postgres" | "mysql";
  /**
   * Deploy-resolvable ORIGIN connection source for schema migrations.
   * Hyperdrive's own connection string is minted per-invocation inside the
   * Worker and cannot be used at deploy time — pass the origin database URL
   * (e.g. Neon `branch.connectionUri`) or leave unset to skip migrations.
   */
  readonly migrate?: MigrateSource;
  readonly pool?: PostgresOptions["pool"] | MySQLOptions["pool"];
}

/**
 * Cloudflare Hyperdrive layer for Better Auth — pooled TCP Postgres (or
 * MySQL) through a Hyperdrive connection.
 *
 * Hyperdrive's connection string is minted per-invocation inside the
 * Worker and cannot be used at deploy time, so pass the ORIGIN database
 * URL as `migrate` for deploy-time schema migrations (or omit it to skip
 * them).
 *
 *
 * ### Pooled Postgres through Hyperdrive
 * The Worker connects over TCP through Hyperdrive's pooler; auth reads
 * should disable Hyperdrive caching so sessions are never stale.
 * **Example:** Hyperdrive over a Neon origin
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { CloudflareHyperdrive } from "@alchemy.run/better-auth/CloudflareHyperdrive";
 *
 * export const PgProject = Neon.Project("AuthDb");
 * export const Hyperdrive = Effect.gen(function* () {
 *   const project = yield* PgProject;
 *   return yield* Cloudflare.Hyperdrive.Connection("AuthHd", {
 *     origin: project.origin,
 *     caching: { disabled: true },
 *   });
 * });
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(
 *   Effect.provide(
 *     Layer.unwrap(
 *       Effect.gen(function* () {
 *         const project = yield* PgProject;
 *         const connection = yield* Hyperdrive;
 *         return CloudflareHyperdrive(connection, {
 *           migrate: project.connectionUri,
 *         });
 *       }),
 *     ),
 *   ),
 * )
 * ```
 *
 * ### MySQL origins
 * Hyperdrive also fronts MySQL origins — select the dialect and the layer
 * drives `mysql2` instead of `pg`.
 * **Example:** MySQL behind Hyperdrive
 * ```typescript
 * CloudflareHyperdrive(connection, {
 *   dialect: "mysql",
 *   migrate: password.connectionUrl,
 * })
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer pg
 * @peer mysql2
 * @product Hyperdrive
 */
export const CloudflareHyperdrive = (
  connection:
    | Cloudflare.Hyperdrive.Connection
    | Effect.Effect<Cloudflare.Hyperdrive.Connection, never, any>,
  options?: CloudflareHyperdriveOptions,
) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const conn = Effect.isEffect(connection)
        ? yield* connection as Effect.Effect<Cloudflare.Hyperdrive.Connection>
        : connection;
      const client = yield* Cloudflare.Hyperdrive.Connect(conn);
      const source = client.connectionString as Effect.Effect<
        Redacted.Redacted<string>,
        never,
        RuntimeContext
      >;
      return options?.dialect === "mysql"
        ? yield* makeMySQLService(source, {
            migrate: options?.migrate ?? false,
            pool: options?.pool as MySQLOptions["pool"],
          })
        : yield* makePostgresService(source, {
            migrate: options?.migrate ?? false,
            pool: options?.pool as PostgresOptions["pool"],
          });
    }),
  ).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
