import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import type { BetterAuthMigrationError } from "./Errors.ts";

/**
 * Cloudflare D1 database layer for Better Auth.
 *
 * At runtime the Worker reaches the database through its native D1 binding
 * (the layer bakes in `QueryDatabaseBinding`). At deploy time, schema
 * migrations run over the D1 HTTP query API — which also transparently
 * targets the local D1 simulator under `alchemy dev`.
 *
 *
 * ### Using D1 as the auth database
 * Provide the layer on the Worker impl effect that yields `BetterAuth`.
 * The database resource can be referenced from module scope — the layer
 * accepts the resource or its Effect.
 * **Example:** Worker with a D1-backed BetterAuth
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * export const AuthDb = Cloudflare.D1.Database("AuthDb");
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const auth = yield* BetterAuth({
 *       basePath: "/auth",
 *       emailAndPassword: { enabled: true },
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         if (request.url.startsWith("/auth")) {
 *           return yield* auth.fetch;
 *         }
 *         const session = yield* auth.getSession();
 *         return yield* HttpServerResponse.json({ user: session?.user ?? null });
 *       }),
 *     };
 *   }).pipe(Effect.provide(CloudflareD1(AuthDb))),
 * ) {}
 * ```
 *
 * ### Migrations
 * The schema migration Action connects over the D1 HTTP API at deploy
 * time — the Worker's native binding is never used outside the deployed
 * runtime, and no migration code ships in the Worker bundle.
 * **Example:** Opting out of automatic migrations
 * ```typescript
 * const auth = yield* BetterAuth({
 *   migrate: false, // manage the schema yourself
 *   emailAndPassword: { enabled: true },
 * });
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @product D1
 */
export const CloudflareD1 = (
  database:
    | Cloudflare.D1.Database
    | Effect.Effect<Cloudflare.D1.Database, never, any>,
) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const db = Effect.isEffect(database)
        ? yield* database as Effect.Effect<Cloudflare.D1.Database>
        : database;
      const client = yield* Cloudflare.D1.QueryDatabase(db);
      const service: DatabaseService = {
        provider: "sqlite",
        runtime: client.raw,
      };
      // Migration support references the deploy-time HTTP/local D1 client
      // (`QueryDatabaseLocal`), which must never reach a Worker bundle —
      // this branch is dead-code-eliminated from deployed runtimes, which
      // also tree-shakes the local-runtime machinery out of the bundle.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        return {
          ...service,
          migrate: {
            identity: { databaseId: db.databaseId } as Record<string, unknown>,
            connect: Effect.gen(function* () {
              // Init half — runs under the migration Action's capture
              // context: `QueryDatabase(database)` yields the databaseId
              // Output, recording the dependency; the client's `raw` is a
              // deferred accessor that resolves at apply.
              const local = yield* Cloudflare.D1.QueryDatabase(db);
              // Apply half — materialize the HTTP D1 facade.
              return Effect.map(
                local.raw,
                (database) => database as DirectDatabase,
              );
            }).pipe(
              Effect.provide(Cloudflare.D1.QueryDatabaseLocal),
              (effect) =>
                // The HTTP client's build requirements (Cloudflare
                // credentials, HttpClient) are ambient during stack-eval
                // where the init half runs.
                effect as unknown as Effect.Effect<
                  Effect.Effect<
                    DirectDatabase,
                    BetterAuthMigrationError,
                    Scope.Scope
                  >,
                  never,
                  RuntimeContext
                >,
            ),
          },
        } satisfies DatabaseService;
      }
      return service;
    }),
  ).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));
