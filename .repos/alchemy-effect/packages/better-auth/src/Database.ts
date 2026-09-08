import type { Input, RuntimeContext } from "alchemy";
import type { BetterAuthOptions } from "better-auth";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { BetterAuthMigrationError } from "./Errors.ts";

/** The database dialect family, as Better Auth's Kysely adapter names them. */
export type Provider = "sqlite" | "postgres" | "mysql";

/**
 * Everything Better Auth accepts as `options.database`: a raw driver object
 * (pg `Pool`, mysql2 pool, `bun:sqlite` `Database`, Cloudflare `D1Database`,
 * ...), a Kysely dialect form, or an adapter factory
 * (`drizzleAdapter(...)`, `memoryAdapter(...)`, custom adapters).
 */
export type DatabaseInput = NonNullable<BetterAuthOptions["database"]>;

/**
 * The Kysely-resolvable subset of {@link DatabaseInput} — raw driver objects
 * and dialect forms, excluding adapter factories.
 *
 * This is the only shape `migrate.connect` may yield: Better Auth's
 * `getMigrations` supports exactly these forms and hard-`process.exit(1)`s
 * on adapter factories, so excluding them statically keeps that landmine
 * unreachable.
 */
export type DirectDatabase = Exclude<
  DatabaseInput,
  (...args: never[]) => unknown
>;

export interface DatabaseService {
  /** Dialect family of the database this layer connects to. */
  readonly provider: Provider;
  /**
   * Build the runtime `options.database` input. Evaluated once per
   * execution (memoized on the execution Scope by {@link BetterAuth}), so
   * disposable resources acquired with `Effect.acquireRelease` — pg/mysql
   * pools — are closed when the event settles. That is the only legal
   * pooling shape on workerd (sockets are IoContext-pinned).
   *
   * Deploy/plan evaluation never runs this effect: construction is deferred
   * to the first `api`/`fetch`/`getSession` use inside an execution scope.
   */
  readonly runtime: Effect.Effect<
    DatabaseInput,
    never,
    RuntimeContext | Scope.Scope
  >;
  /**
   * Deploy-time migration support. `undefined` means this platform cannot
   * auto-migrate (memory, drizzle, custom adapters): {@link BetterAuth}
   * skips migration registration, and fails synth if `migrate: true` was
   * explicitly requested.
   */
  readonly migrate?: {
    /**
     * Non-secret, canonically-hashable identity of the target database
     * (resource Outputs allowed) — part of the migration Action's input, so
     * migrations re-run when the target database is replaced.
     *
     * MUST NOT contain the connection string: Action input is persisted to
     * alchemy state.
     */
    readonly identity: Input<Record<string, unknown>>;
    /**
     * Two-stage connection for the migration Action.
     *
     * The OUTER effect is the Action's *init* half: it runs at stack-eval
     * time under the Action's capture context — this is where resource
     * Outputs (`database.databaseId`, a connection-string attr) MUST be
     * yielded so the engine records them as dependency captures and
     * resolves them at apply. No I/O here.
     *
     * The INNER effect is the *apply* half: it runs inside the Action body
     * with the resolved captures ambient, acquires the actual client/pool
     * on the Scope (`pool.end` / `db.close` ride it), and yields a
     * Kysely-resolvable database.
     */
    readonly connect: Effect.Effect<
      Effect.Effect<DirectDatabase, BetterAuthMigrationError, Scope.Scope>,
      never,
      RuntimeContext
    >;
  };
}

/**
 * The database dependency of {@link BetterAuth}.
 *
 * Platform layers (`Memory`, `SQLite`, `CloudflareD1`, `Postgres`, `MySQL`,
 * `Drizzle`, ...) provide this service; `yield* BetterAuth({...})` consumes
 * it. Provide the layer on the surrounding impl effect:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(Effect.provide(CloudflareD1(Db)))
 * ```
 */
export class Database extends Context.Service<Database, DatabaseService>()(
  "BetterAuth.Database",
) {}
