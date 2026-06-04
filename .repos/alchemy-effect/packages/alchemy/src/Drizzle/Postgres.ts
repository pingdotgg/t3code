import * as PgClient from "@effect/sql-pg/PgClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ExecutionContext } from "../ExecutionContext.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Open a Drizzle/Postgres database from a connection URL using the
 * `drizzle-orm/effect-postgres` integration.
 *
 * Returns a chainable Proxy over `EffectPgDatabase` (via `proxyChain`) —
 * every property read records a step, every call records args, and the
 * chain is replayed against the resolved drizzle db when it's finally
 * yielded as an Effect. Callers don't need a separate `yield* conn` step:
 *
 * ```typescript
 * const db = yield* Drizzle.postgres(hd.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * Behind the scenes the actual connect work is wrapped in `Effect.cached`,
 * so the pool is built at most once per JS realm. Yielding the
 * connection string is also deferred until first query, so deploy /
 * plan-time invocations (where `WorkerEnvironment` isn't provided)
 * never trigger a real connection attempt.
 *
 * The PgClient pool is built against an isolated, never-closing `Scope`
 * so it outlives whatever scope this helper is yielded under. In a
 * Cloudflare Worker the surrounding `Cloudflare.Worker` runs init
 * inside `Effect.scoped`, which closes after returning the exports
 * object — without an isolated scope, the pool's `end` finalizer
 * would fire there and every subsequent request would see "Cannot
 * use a pool after end".
 *
 * @binding
 */

export const postgres = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: PgDrizzle.EffectDrizzlePgConfig<TRelations>,
) =>
  Effect.sync(function () {
    const symbol = Symbol();

    return proxyChain<
      EffectPgDatabase<TRelations> & {
        $client: PgClient.PgClient;
      }
    >(
      Effect.gen(function* () {
        const ctx = yield* ExecutionContext;
        return yield* (ctx.cache[symbol] ??= yield* Effect.gen(function* () {
          const pgCtx = yield* Layer.buildWithScope(
            PgClient.layer({ url: yield* connectionString }),
            ctx.scope,
          );
          return yield* PgDrizzle.makeWithDefaults(config).pipe(
            Effect.provideContext(pgCtx),
          );
        }).pipe(Effect.cached));
      }) as Effect.Effect<
        EffectPgDatabase<TRelations> & {
          $client: PgClient.PgClient;
        }
      >,
    );
  });
