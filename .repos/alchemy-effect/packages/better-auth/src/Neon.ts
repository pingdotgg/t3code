import {
  resolveConnectionSource,
  staticConnectionSource,
  type ConnectionSource,
} from "alchemy/SQL/ConnectionSource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import { makeMigrateSupport, type SqlLayerOptions } from "./Postgres.ts";

export interface NeonOptions extends SqlLayerOptions {}

// The Neon serverless Pool is pg-compatible (Better Auth's Kysely path
// duck-types it as a Postgres pool via its `connect` method) but speaks
// WebSocket instead of TCP — no `pg`, no Hyperdrive, no nodejs socket
// APIs. Loaded dynamically so the driver stays an optional peer.
const loadNeonPool = Effect.promise(
  () => import("@neondatabase/serverless"),
).pipe(
  Effect.map((mod) =>
    (mod as { default?: { Pool?: unknown } }).default?.Pool !== undefined
      ? (
          mod as unknown as {
            default: {
              Pool: new (config: {
                connectionString: string;
                max?: number;
              }) => unknown;
            };
          }
        ).default.Pool
      : (
          mod as unknown as {
            Pool: new (config: {
              connectionString: string;
              max?: number;
            }) => unknown;
          }
        ).Pool,
  ),
);

const openPool = (
  urlEffect: Effect.Effect<Redacted.Redacted<string>>,
): Effect.Effect<DirectDatabase, never, Scope.Scope> =>
  Effect.gen(function* () {
    const Pool = yield* loadNeonPool;
    const url = Redacted.value(yield* urlEffect);
    return (yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
      (pool) => Effect.promise(() => (pool as { end(): Promise<void> }).end()),
    )) as DirectDatabase;
  });

/**
 * Neon database layer for Better Auth over Neon's serverless driver.
 *
 * This is the optimal Workers/Lambda → Neon pairing: the driver speaks
 * WebSocket instead of TCP, so it needs no Hyperdrive, no `pg` install,
 * and no socket compatibility flags. One pool per execution, closed when
 * the event settles.
 *
 * For TCP access through Cloudflare Hyperdrive use `CloudflareHyperdrive`;
 * for a generic `pg` connection use `Postgres`.
 *
 *
 * ### Connecting from a Worker or Lambda
 * The `connectionUri` Output binds into the host environment at deploy
 * and is read back at runtime; the same source drives the deploy-time
 * migration Action.
 * **Example:** Worker (or Lambda) with a Neon-backed BetterAuth
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { Neon as NeonDatabase } from "@alchemy.run/better-auth/Neon";
 * import * as Neon from "alchemy/Neon";
 *
 * export const AuthDb = Neon.Project("AuthDb");
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(
 *   Effect.provide(
 *     Layer.unwrap(Effect.map(AuthDb, (db) => NeonDatabase(db.connectionUri))),
 *   ),
 * )
 * ```
 *
 * ### Branch-per-stage setups
 * Point the layer at a branch's connection string instead of the project's
 * to isolate auth data per stage.
 * **Example:** Using a Neon branch
 * ```typescript
 * const branch = yield* Neon.Branch("auth-db", { project });
 * // ...
 * Effect.provide(Layer.unwrap(Effect.map(branch, (b) => NeonDatabase(b.connectionUri))))
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer @neondatabase/serverless
 * @product Neon
 */
export const Neon = (
  url: ConnectionSource,
  options?: NeonOptions,
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const urlEffect = yield* resolveConnectionSource(url);
      const migrateSource = staticConnectionSource(url, options?.migrate);

      return {
        provider: "postgres",
        runtime: openPool(urlEffect) as DatabaseService["runtime"],
        ...(migrateSource === undefined
          ? {}
          : {
              migrate: makeMigrateSupport(
                migrateSource,
                openPool,
                "Failed to connect to Neon for Better Auth schema migrations",
              ),
            }),
      } satisfies DatabaseService;
    }),
  ) as Layer.Layer<Database>;
