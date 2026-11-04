import type { LibSQLConfig, LibSQLSource } from "@alchemy.run/sql/SQLite";
// `@effect/sql-libsql` (and @libsql/client underneath) are optional peers —
// value imports are deferred to first use so `@alchemy.run/drizzle` resolves
// without them installed.
import type * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { proxyChain } from "alchemy/Util/proxy-chain";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectLibsqlDatabase } from "drizzle-orm/effect-libsql";
import type { EffectDrizzleSQLiteConfig } from "drizzle-orm/sqlite-core/effect/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Open a Drizzle database over a libSQL database (e.g. Turso) using the
 * `drizzle-orm/effect-libsql` integration.
 *
 * Accepts the client returned by `Turso.Connect(db)` — or any
 * `{ url, authToken }` — and returns a chainable Proxy over
 * `EffectLibsqlDatabase` (via `proxyChain`): every property read records a
 * step, every call records args, and the chain is replayed against the
 * resolved drizzle db when it's finally yielded as an Effect. Callers don't
 * need a separate `yield* conn` step:
 *
 * ```typescript
 * const conn = yield* Turso.Connect(Db);
 * const db = yield* Drizzle.LibSQL(conn, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The client is built lazily on the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so it is
 * created at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation —
 * and closed when that execution settles. Resolving the URL and token is
 * likewise deferred, so deploy / plan-time invocations never connect.
 *
 * `@effect/sql-libsql` client options (e.g. `intMode`) are passed via
 * `config.client`.
 *
 * @binding
 */
export const LibSQL = <TRelations extends AnyRelations = EmptyRelations, E = never, R = never>(
  source: LibSQLSource<E, R>,
  config?: EffectDrizzleSQLiteConfig<TRelations> & {
    /** Overrides for the underlying `@effect/sql-libsql` client. */
    readonly client?: LibSQLConfig;
  },
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const [LibsqlClient, LibsqlDrizzle, { resolveLibSQLConfig }] = yield* Effect.promise(() =>
          Promise.all([
            import("@effect/sql-libsql/LibsqlClient"),
            import("drizzle-orm/effect-libsql"),
            import("@alchemy.run/sql/SQLite"),
          ]),
        );
        const { client, ...drizzleConfig } = config ?? {};
        const ctx = yield* Layer.build(
          LibsqlClient.layer(yield* resolveLibSQLConfig(source, client)),
        );
        return yield* LibsqlDrizzle.makeWithDefaults(
          drizzleConfig as EffectDrizzleSQLiteConfig<TRelations>,
        ).pipe(Effect.provideContext(ctx));
      }),
    ),
    (db) =>
      proxyChain<EffectLibsqlDatabase<TRelations> & { $client: LibsqlClient.LibsqlClient }>(db),
  );
