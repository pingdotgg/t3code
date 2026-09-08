import type * as runtime from "@cloudflare/workers-types";
import * as D1Client from "@effect/sql-d1/D1Client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sql from "effect/unstable/sql/SqlClient";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * A source of the raw Cloudflare `D1Database` binding. Structurally matches
 * the client returned by `Cloudflare.D1.QueryDatabase(db)` (its `raw`
 * accessor), so both the client and a bare effect are accepted.
 */
export type D1DatabaseSource<E, R> =
  | Effect.Effect<runtime.D1Database, E, R>
  | { readonly raw: Effect.Effect<runtime.D1Database, E, R> };

/**
 * Options forwarded to `@effect/sql-d1`'s `D1Client` (everything except the
 * `db` binding itself, which alchemy resolves from the Worker environment).
 */
export type D1Config = Omit<D1Client.D1ClientConfig, "db">;

/**
 * Open an `@effect/sql-d1` client over a Cloudflare D1 binding.
 *
 * Accepts the client returned by `Cloudflare.D1.QueryDatabase(db)` — or its
 * `raw` effect directly — and returns a `D1Client` (which implements the
 * generic `SqlClient` interface) wrapped in a chainable Proxy, so it can be
 * resolved once at Worker init and used from any handler:
 *
 * ```typescript
 * import * as SQL from "alchemy/SQL/D1";
 *
 * const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
 * const sql = yield* SQL.D1(d1);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * The client build is deferred until the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so the
 * `D1Client` (and its prepared-statement cache) is built at most once per
 * execution — a Worker `fetch`/`queue`/`scheduled` event, a Durable Object
 * call, or a Workflow run — and torn down when the event settles. Deploy /
 * plan-time invocations never touch D1.
 *
 * @binding
 */
export const D1 = <E = never, R = never>(
  database: D1DatabaseSource<E, R>,
  config?: D1Config,
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const db = yield* Effect.isEffect(database) ? database : database.raw;
        const d1Ctx = yield* Layer.build(D1Client.layer({ ...config, db }));
        return Context.get(d1Ctx, D1Client.D1Client);
      }),
    ),
    (client) => proxyChain<D1Client.D1Client>(client),
  );

/**
 * Provide an `@effect/sql-d1` client as the `D1Client` and generic
 * `SqlClient` services, so cloud-agnostic services written against
 * `SqlClient.SqlClient` (or drizzle's `effect-d1` driver, which depends on
 * `D1Client`) run on a bound D1 database:
 *
 * ```typescript
 * const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
 * const app = yield* makeApp.pipe(Effect.provide(SQL.D1Layer(d1)));
 * ```
 *
 * The layer itself builds synchronously at Worker init; the underlying
 * `D1Client` is created lazily per execution (see {@link D1}).
 */
export const D1Layer = <E = never, R = never>(
  database: D1DatabaseSource<E, R>,
  config?: D1Config,
) =>
  // Derive SqlClient from the single D1Client build so both tags share one
  // per-execution client (and one prepared-statement cache).
  Layer.effect(
    Sql.SqlClient,
    Effect.gen(function* () {
      return yield* D1Client.D1Client;
    }),
  ).pipe(
    Layer.provideMerge(Layer.effect(D1Client.D1Client, D1(database, config))),
  );
