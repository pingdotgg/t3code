import type { RuntimeContext } from "alchemy";
import {
  connectionSourceDigest,
  resolveConnectionSource,
  staticConnectionSource,
  type ConnectionSource,
  type StaticConnectionSource,
} from "alchemy/SQL/ConnectionSource";
import { openPostgresPool } from "alchemy/SQL/PostgresDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { PoolConfig } from "pg";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";

export type { ConnectionSource };
/** Deploy-resolvable connection source usable for migrations. */
export type MigrateSource = StaticConnectionSource;

export interface SqlLayerOptions {
  /**
   * Deploy-resolvable connection source for schema migrations. Defaults to
   * the layer's own `url` when that is deploy-resolvable (a literal or a
   * resource Output); a runtime-only `url` (Hyperdrive) has no default —
   * pass the origin URL here, or `false` to disable migration support.
   */
  readonly migrate?: MigrateSource | false;
  /** Extra driver pool options (`max` defaults to 1 per execution). */
  readonly pool?: Record<string, unknown>;
}

export interface PostgresOptions extends SqlLayerOptions {
  readonly pool?: Omit<PoolConfig, "connectionString">;
}

/**
 * Build a `migrate` config over a scoped open-connection effect: the init
 * half captures the connection-string Output, the apply half opens the
 * driver against the resolved value.
 *
 * @internal
 */
export const makeMigrateSupport = (
  migrateSource: MigrateSource,
  open: (
    url: Effect.Effect<Redacted.Redacted<string>>,
  ) => Effect.Effect<DirectDatabase, never, Scope.Scope>,
  failure: string,
): NonNullable<DatabaseService["migrate"]> => ({
  identity: { urlDigest: connectionSourceDigest(migrateSource) } as Record<
    string,
    unknown
  >,
  connect: Effect.gen(function* () {
    // Init half — capture the connection-string Output.
    const urlAccessor = yield* resolveConnectionSource(migrateSource);
    // Apply half — load the driver and open the pool.
    return open(urlAccessor).pipe(
      Effect.catchDefect((cause: unknown) =>
        Effect.fail(new BetterAuthMigrationError({ message: failure, cause })),
      ),
    );
  }) as Effect.Effect<
    Effect.Effect<DirectDatabase, BetterAuthMigrationError, Scope.Scope>,
    never,
    RuntimeContext
  >,
});

/**
 * Build the Postgres {@link DatabaseService}.
 *
 * @internal
 */
export const makePostgresService = (
  source: ConnectionSource,
  options: PostgresOptions | undefined,
): Effect.Effect<DatabaseService> =>
  Effect.gen(function* () {
    const urlEffect = yield* resolveConnectionSource(source);
    const migrateSource = staticConnectionSource(source, options?.migrate);
    const open = (url: Effect.Effect<Redacted.Redacted<string>>) =>
      openPostgresPool(url, options?.pool) as Effect.Effect<
        DirectDatabase,
        never,
        Scope.Scope
      >;

    return {
      provider: "postgres",
      runtime: open(urlEffect) as DatabaseService["runtime"],
      ...(migrateSource === undefined
        ? {}
        : {
            migrate: makeMigrateSupport(
              migrateSource,
              open,
              "Failed to load `pg` — install it to migrate a Postgres-backed BetterAuth",
            ),
          }),
    } satisfies DatabaseService;
  }) as Effect.Effect<DatabaseService>;

/**
 * Generic TCP Postgres database layer for Better Auth, from a connection
 * string.
 *
 * Works with every Postgres alchemy exposes a connection string for:
 * PlanetScale Postgres (`role.connectionUrl`), Prisma Postgres
 * (`connection.databaseUrl`), AWS RDS inside a VPC, or any literal URL.
 * One `pg.Pool` is opened per execution and closed when the event settles
 * — the only legal pooling shape on workerd. Prefer `Neon`,
 * `AuroraDataApi`, or `CloudflareHyperdrive` when they match your
 * environment → database pair.
 *
 * On AWS Lambda, add `build: { install: ["pg"] }` to the Function props so
 * the dynamically-imported driver ships in the artifact with an npm layout
 * (its CJS require chain does not survive store-style node_modules).
 *
 *
 * ### Connecting with a resource Output
 * Resource Outputs are bound into the host environment at deploy and read
 * back at runtime; the same source drives deploy-time migrations.
 * **Example:** PlanetScale Postgres
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { Postgres } from "@alchemy.run/better-auth/Postgres";
 *
 * const role = yield* Planetscale.PostgresRole("auth-role", { database, branch });
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(Effect.provide(Postgres(role.connectionUrl)))
 * ```
 *
 * ### Separate migration source
 * When the runtime URL is not deploy-resolvable (or points at a pooler),
 * pass a direct deploy-time URL as `migrate`.
 * **Example:** Pooled runtime, direct migrations
 * ```typescript
 * Postgres(role.connectionUrlPooled, { migrate: role.connectionUrl })
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer pg
 * @product Postgres
 */
export const Postgres = (
  url: ConnectionSource,
  options?: PostgresOptions,
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    makePostgresService(url, options),
  ) as Layer.Layer<Database>;
