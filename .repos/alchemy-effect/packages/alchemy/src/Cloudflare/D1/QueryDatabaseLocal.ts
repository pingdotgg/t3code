import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { isLocalId } from "../LocalRuntime.ts";
import type { Database } from "./Database.ts";
import { localD1GatewayRuntime, withLocalD1Query } from "./LocalD1Gateway.ts";
import { QueryDatabase } from "./QueryDatabase.ts";
import {
  type D1Auth,
  makeD1DatabaseFromTransport,
  makeHttpD1Database,
  makeQueryDatabaseClientFrom,
} from "./QueryDatabaseHttpClient.ts";

/**
 * Local implementation of the {@link QueryDatabase} binding — queries D1 over
 * the Cloudflare HTTP API using the **current credentials** instead of a native
 * Worker binding (`QueryDatabaseBinding`) or a scoped API token.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can talk to
 * a D1 database with the same `prepare`/`exec`/`batch` client you'd use inside a
 * Worker:
 *
 * @example Seeding a database from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const db = yield* Cloudflare.D1.QueryDatabase(database);
 *     return Effect.fn(function* () {
 *       yield* db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT, name TEXT)");
 *       yield* db
 *         .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
 *         .bind("1", "Ada")
 *         .run();
 *     });
 *   }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
 * );
 * ```
 *
 * The database id is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `QueryDatabase(database)` works even though the
 * database is created in the same deploy.
 */
export const QueryDatabaseLocal = Layer.effect(
  QueryDatabase,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the HTTP query ops run
    // with the current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth: D1Auth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      accountId,
    };
    // The FULL ambient context, for the dev-mode gateway: booting an
    // ephemeral workerd needs the platform services (FileSystem, Path,
    // spawner, HttpClient) and the Cloudflare environment, all of which are
    // present during stack-eval but not statically enumerable here.
    const ambient = yield* Effect.context<never>();

    // Under `alchemy dev` the database may be a local simulator row (a
    // `dev:` id). Queries then tunnel through an ephemeral workerd gateway
    // into the simulator's DO SQLite (one gateway boot per query — slow but
    // correct; Actions are deploy-time one-shots). Real ids keep the cloud
    // HTTP query API.
    const localTransport =
      (databaseId: string) =>
      (
        body:
          | { sql: string; params?: unknown[] }
          | { batch: { sql: string; params?: unknown[] }[] },
      ) =>
        withLocalD1Query(databaseId, (query) => query(body)).pipe(
          Effect.provide(localD1GatewayRuntime),
          // The gateway layer's platform requirements are satisfied by the
          // ambient stack-eval context captured above; `Context<never>`
          // can't prove that statically, so erase the leftover R.
          Effect.provideContext(ambient),
          (eff) => Effect.runPromise(eff as Effect.Effect<never, never>),
        ) as Promise<{
          result: Array<{
            results?: unknown;
            success?: boolean | null;
            meta?: unknown;
          }>;
        }>;

    return Effect.fn(function* (database: Database) {
      // Deferred accessor — resolves the databaseId against the tracker at
      // apply time. No `host.bind`: the local variant registers no binding.
      const databaseId = yield* database.databaseId;
      return makeQueryDatabaseClientFrom(
        Effect.map(databaseId, (id) =>
          isLocalId(id)
            ? makeD1DatabaseFromTransport(localTransport(id))
            : makeHttpD1Database(auth, id),
        ),
      );
    });
  }),
);
