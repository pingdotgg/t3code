import * as D1Client from "@effect/sql-d1/D1Client";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectSQLiteD1Database } from "drizzle-orm/effect-d1";
import * as SQLiteD1Drizzle from "drizzle-orm/effect-d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { D1DatabaseSource } from "../SQL/D1.ts";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Open a Drizzle database over a Cloudflare D1 binding using the
 * `drizzle-orm/effect-d1` integration (which drives queries through
 * `@effect/sql-d1`'s `D1Client`).
 *
 * Accepts the client returned by `Cloudflare.D1.QueryDatabase(db)` — or its
 * `raw` effect directly — and returns a chainable Proxy over
 * `EffectSQLiteD1Database` (via `proxyChain`): every property read records a
 * step, every call records args, and the chain is replayed against the
 * resolved drizzle db when it's finally yielded as an Effect. Callers don't
 * need a separate `yield* conn` step:
 *
 * ```typescript
 * const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
 * const db = yield* Drizzle.D1(d1, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The client build is deferred until the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so the
 * `D1Client` (and its prepared-statement cache) is built at most once per
 * execution — a Worker `fetch`/`queue`/`scheduled` event, a Durable Object
 * call, or a Workflow run — and reused across every query in that execution.
 * Resolving the binding is likewise deferred, so deploy / plan-time
 * invocations (where `WorkerEnvironment` isn't provided) never touch D1.
 *
 * The client is built against that same execution scope, so its finalizer
 * fires when the scope closes — when the request / run settles, not when the
 * Worker's isolate-lifetime init completes. Wrapping queries in a nested
 * `Effect.scoped` narrows both the memo and the client's lifetime to that
 * block: memo key and finalizer target are always the same scope object, so
 * they cannot disagree.
 *
 * @binding
 */
export const D1 = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  database: D1DatabaseSource<E, R>,
  config?: SQLiteD1Drizzle.EffectDrizzleSQLiteD1Config<TRelations>,
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const db = yield* Effect.isEffect(database) ? database : database.raw;
        const d1Ctx = yield* Layer.build(D1Client.layer({ db }));
        return yield* SQLiteD1Drizzle.makeWithDefaults(
          config ??
            ({} as SQLiteD1Drizzle.EffectDrizzleSQLiteD1Config<TRelations>),
        ).pipe(Effect.provideContext(d1Ctx));
      }),
    ),
    (db) =>
      proxyChain<
        EffectSQLiteD1Database<TRelations> & {
          $client: D1Client.D1Client;
        }
      >(
        db as Effect.Effect<
          EffectSQLiteD1Database<TRelations> & {
            $client: D1Client.D1Client;
          }
        >,
      ),
  );
