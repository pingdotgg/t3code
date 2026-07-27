import * as PgClient from "@effect/sql-pg/PgClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { EffectDrizzlePgConfig } from "drizzle-orm/pg-core/effect/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
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
 * const db = yield* Drizzle.Postgres(hd.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The connect work is deferred until the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so the pool
 * is built at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation — and
 * reused across every query and `task` step in that execution. Yielding the
 * connection string is likewise deferred, so deploy / plan-time invocations
 * (where `WorkerEnvironment` isn't provided) never trigger a real connection
 * attempt.
 *
 * The pool is built against that same execution scope, so its `end`
 * finalizer fires when the scope closes — when the request / run settles,
 * not when the Worker's isolate-lifetime init completes. Wrapping queries in
 * a nested `Effect.scoped` narrows both the memo and the pool's lifetime to
 * that block: memo key and finalizer target are always the same scope
 * object, so they cannot disagree.
 *
 * @binding
 */

export const Postgres = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: EffectDrizzlePgConfig<TRelations>,
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const pgCtx = yield* Layer.build(
          PgClient.layer({ url: yield* connectionString }),
        );
        return yield* PgDrizzle.makeWithDefaults(config).pipe(
          Effect.provideContext(pgCtx),
        );
      }),
    ),
    (db) =>
      proxyChain<
        EffectPgDatabase<TRelations> & {
          $client: PgClient.PgClient;
        }
      >(
        db as Effect.Effect<
          EffectPgDatabase<TRelations> & {
            $client: PgClient.PgClient;
          }
        >,
      ),
  );
