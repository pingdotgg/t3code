import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import type { ReplacedResourceState } from "./ResourceState.ts";
import {
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "./State.ts";
import { encodeState, reviveStateRecursive } from "./StateEncoding.ts";

// `@effect/sql-pg` is loaded lazily rather than imported statically (as
// `SQL/Postgres.ts` does) so that `postgresState({ client })` — which takes
// any `@effect/sql` client — works without the optional peer installed at
// all. Only `postgresState({ url })`, which builds a pool, needs it.
// `@effect/sql-pg` depends on `pg` itself, so `pg` is never imported here.
const importPgClient = () =>
  import("@effect/sql-pg/PgClient").catch((cause) => {
    throw new Error(
      "Failed to load '@effect/sql-pg'. Install the optional peer dependency '@effect/sql-pg' to use postgresState with a `url`.",
      { cause },
    );
  });

export interface PostgresStateOptions<E = never, R = never> {
  /**
   * An existing `@effect/sql` client. The caller owns its lifecycle — the
   * store only issues queries against it. Exactly one of `client` and `url`
   * must be provided.
   *
   * The client must be **pool-backed** and able to hand out at least two
   * concurrent connections: the store keeps one connection reserved for the
   * advisory lock and verifies that lock from another one. A
   * single-connection client (`PgClient.makeClient`) is refused at the first
   * lease check, and a pool capped at `maxConnections: 1` blocks forever
   * waiting for a free connection.
   */
  client?: SqlClient.SqlClient;
  /**
   * Postgres connection URL, as a `Redacted` value or an Effect yielding one
   * — `Config.redacted("STATE_DATABASE_URL")` is itself an Effect, so it can
   * be passed directly. The store creates its own `@effect/sql-pg` pool from
   * the URL and closes that pool when the state layer is released.
   */
  url?:
    | Redacted.Redacted<string>
    | Effect.Effect<Redacted.Redacted<string>, E, R>;
  /**
   * Prefix for the advisory-lock key. The full key for a stack/stage is
   * `{lockKeyPrefix}:{stack}/{stage}`.
   *
   * @default "alchemy"
   */
  lockKeyPrefix?: string;
  /**
   * State-store id reported in telemetry (`alchemy.state_store.id`).
   *
   * @default "postgres"
   */
  id?: string;
  /**
   * How long (in milliseconds) a passing lease check is trusted before the
   * next state operation re-verifies the advisory lock. A lease lost inside
   * the window is detected within this many milliseconds rather than
   * instantly; in exchange, a burst of state operations does one lock
   * round-trip instead of one per operation.
   *
   * @default 5000
   */
  leaseCheckTtlMs?: number;
}

const DEFAULT_LEASE_CHECK_TTL_MS = 5_000;

/**
 * Amortizes a lease check over a short TTL: a passing check is trusted for
 * `ttlMs`, so a burst of operations inside the window does one round-trip,
 * not one per operation. A failing check is never cached — it propagates
 * immediately and leaves the last-good timestamp untouched, so the very
 * next operation re-checks.
 */
const amortizeCheck = (
  checkLive: Effect.Effect<void, StateStoreError>,
  ttlMs: number,
): Effect.Effect<void, StateStoreError> => {
  let lastOkAt: number | undefined;
  return Effect.suspend(() => {
    if (lastOkAt !== undefined && Date.now() - lastOkAt < ttlMs) {
      return Effect.void;
    }
    return checkLive.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          lastOkAt = Date.now();
        }),
      ),
    );
  });
};

interface Lease {
  readonly checkLive: Effect.Effect<void, StateStoreError>;
}

/**
 * State store backed by any Postgres database.
 *
 * Stack state lives in two tables — `alchemy_resource_state` and
 * `alchemy_stack_output` — created on first use with
 * `create table if not exists`.
 *
 * Concurrent deploys are serialized with a session-scoped Postgres advisory
 * lock per `(stack, stage)`: the lock is taken on a reserved connection
 * (`SqlClient.reserve`) when the first operation for the pair runs, and
 * contention fails immediately instead of queueing. Every subsequent
 * operation first re-verifies — from a *different* connection, by inspecting
 * `pg_locks` — that the backend which took the lock still holds it, so a
 * dropped lock connection fails loudly instead of letting operations run
 * unlocked. That check reports the backend it ran on as well, so a
 * single-connection client, which would have the lock holder vouch for
 * itself, is refused instead of silently trusted. If the process crashes,
 * Postgres releases the session lock when the connection drops; no recovery
 * bookkeeping is needed.
 *
 * ### Using the Postgres State Store
 * **Example:** Connection URL from configuration
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import { postgresState } from "alchemy/State/PostgresState";
 * import * as Config from "effect/Config";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: myProviders(),
 *     state: postgresState({ url: Config.redacted("STATE_DATABASE_URL") }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * **Example:** Caller-owned pool
 * ```typescript
 * import * as PgClient from "@effect/sql-pg/PgClient";
 * import * as Config from "effect/Config";
 *
 * // A pool, not `PgClient.makeClient`: the store needs a second connection
 * // to verify the advisory lock held on the reserved one.
 * const sql = yield* PgClient.make({
 *   url: yield* Config.redacted("STATE_DATABASE_URL"),
 * });
 * const state = postgresState({
 *   client: sql,
 *   lockKeyPrefix: yield* Config.string("STATE_LOCK_PREFIX"),
 * });
 * ```
 */
export const postgresState = <E = never, R = never>(
  options: PostgresStateOptions<E, R>,
) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      // The layer carries the `url` Effect's requirements; the service it
      // builds must not, so they are provided here, once.
      const context = yield* Effect.context<R>();

      const make = makePostgresState(options, scope).pipe(
        recordStateStoreInit,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  );

/**
 * Construct a Postgres-backed {@link StateService}.
 *
 * Construction itself never touches the database — pool creation (when a
 * `url` was given), schema migration, and advisory-lock acquisition are all
 * deferred to the first state operation. Finalizers for the advisory locks
 * and any store-owned pool are registered on `scope`.
 */
export const makePostgresState = <E = never, R = never>(
  options: PostgresStateOptions<E, R>,
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const prefix = options.lockKeyPrefix ?? "alchemy";
    const ttlMs = options.leaseCheckTtlMs ?? DEFAULT_LEASE_CHECK_TTL_MS;
    // Captured once, so a `url` Effect that needs services (a custom
    // ConfigProvider, say) can still be resolved later — from inside the
    // service methods, whose own requirements are fixed at `never`.
    const context = yield* Effect.context<R>();

    const toError = (cause: unknown): StateStoreError =>
      cause instanceof StateStoreError
        ? cause
        : new StateStoreError({
            message:
              cause instanceof Error
                ? cause.message
                : `Postgres state store error: ${String(cause)}`,
            cause: cause instanceof Error ? cause : undefined,
          });

    const stateError = <A, E2, R2>(
      effect: Effect.Effect<A, E2, R2>,
    ): Effect.Effect<A, StateStoreError, R2> =>
      Effect.mapError(effect, toError);

    /**
     * Idempotent schema migration. Concurrent `create table if not exists`
     * statements can still collide inside Postgres on the shared catalog
     * rows (duplicate pg_type/pg_class key errors), so the migration runs
     * in a transaction — one connection, pinned by `withTransaction` — that
     * first takes a transaction-scoped advisory lock on a fixed migration
     * key. The lock releases automatically at commit or rollback.
     */
    const migrate = (sql: SqlClient.SqlClient) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`select pg_advisory_xact_lock(hashtextextended(${`${prefix}:schema`}, 0))`;
            yield* sql`
              create table if not exists alchemy_resource_state (
                stack text not null,
                stage text not null,
                fqn text not null,
                value jsonb not null,
                updated_at timestamptz not null default now(),
                primary key (stack, stage, fqn)
              )
            `;
            yield* sql`
              create table if not exists alchemy_stack_output (
                stack text not null,
                stage text not null,
                value jsonb not null,
                updated_at timestamptz not null default now(),
                primary key (stack, stage)
              )
            `;
          }),
        )
        .pipe(stateError);

    /**
     * Builds a store-owned `@effect/sql-pg` pool. Its `end` finalizer is
     * registered on `scope`, so the pool closes with the state layer.
     */
    const openPool = (
      url: NonNullable<PostgresStateOptions<E, R>["url"]>,
    ): Effect.Effect<SqlClient.SqlClient, StateStoreError> =>
      Effect.gen(function* () {
        const PgClient = yield* Effect.tryPromise({
          try: importPgClient,
          catch: toError,
        });
        const resolved = Effect.isEffect(url)
          ? yield* Effect.provideContext(url, context).pipe(stateError)
          : url;
        const built = yield* Layer.build(
          PgClient.layer({ url: resolved }),
        ).pipe(Scope.provide(scope), stateError);
        return Context.get(built, PgClient.PgClient);
      });

    // Nothing touches the database at layer construction time. The client
    // is resolved (or created from the URL) and the schema migrated inside
    // this cached Effect, which runs once on the first state operation.
    const ready = yield* Effect.cached(
      Effect.gen(function* () {
        const { client, url } = options;
        const resolved: SqlClient.SqlClient =
          client !== undefined && url === undefined
            ? client
            : url !== undefined && client === undefined
              ? yield* openPool(url)
              : yield* Effect.fail(
                  new StateStoreError({
                    message:
                      "postgresState requires exactly one of `client` or `url`",
                  }),
                );
        // The store reads columns by the exact names written below, so a
        // client configured with name transforms must not rewrite them.
        const sql = resolved.withoutTransforms();
        yield* migrate(sql);
        return sql;
      }),
    );

    const run = <A>(
      f: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>,
    ): Effect.Effect<A, StateStoreError> =>
      ready.pipe(Effect.flatMap((sql) => stateError(f(sql))));

    const lockKey = (stack: string, stage: string) =>
      `${prefix}:${stack}/${stage}`;

    /**
     * Acquires the session-scoped advisory lock for `key` on a connection
     * reserved for the store's lifetime. Session (not transaction) scope,
     * because a deploy spans many commits. Contention fails immediately
     * rather than queueing.
     */
    const acquireLease = (key: string): Effect.Effect<Lease, StateStoreError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const sql = yield* restore(ready);
          // Forked from the store's scope, so the reserved connection is
          // reclaimed with the store even if nothing below closes it. From
          // here to the unlock finalizer nothing is interruptible: handing
          // a connection back to the pool while it still holds a session
          // lock would strand that lock until the process exits, and every
          // later deploy of this stack/stage would fail on it.
          const lockScope = yield* Scope.fork(scope);
          const releaseReserved = Scope.close(lockScope, Exit.void);
          const reserved = yield* restore(
            sql.reserve.pipe(Scope.provide(lockScope), stateError),
          ).pipe(Effect.onError(() => releaseReserved));

          // Pins a statement to the reserved connection exactly the way
          // `withTransaction` does, so spans, span attributes and row
          // handling stay identical to every other statement.
          const onReserved = <A>(
            effect: Effect.Effect<A, SqlError.SqlError>,
          ): Effect.Effect<A, SqlError.SqlError> =>
            Effect.provideService(effect, sql.transactionService, [
              reserved,
              0,
            ]);

          const acquired = yield* onReserved(
            sql`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired, pg_backend_pid() as pid`,
          ).pipe(
            stateError,
            Effect.map((rows) => rows[0]),
            Effect.onError(() => releaseReserved),
          );
          if (acquired?.acquired !== true) {
            yield* releaseReserved;
            return yield* Effect.fail(
              new StateStoreError({
                message: `another deploy holds the Postgres state lock '${key}'`,
              }),
            );
          }
          const lockPid = Number(acquired.pid);

          yield* Scope.addFinalizer(
            scope,
            onReserved(
              sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`,
            ).pipe(
              // If the connection already dropped, Postgres auto-released
              // the session-scoped lock; there is nothing left to unlock.
              Effect.ignore,
              Effect.andThen(releaseReserved),
            ),
          );

          // Deliberately verifies from a DIFFERENT connection, never the
          // reserved one: once the reserved connection's backend has been
          // killed server-side, querying it cannot answer reliably. Asking
          // another connection whether the backend pid captured at acquire
          // time still holds this advisory lock in `pg_locks` gives the same
          // answer (a dead or reused backend cannot hold the lock) without
          // touching the connection that might be dead. The check reports
          // its own backend pid too, because a single-connection client
          // routes it straight back to the lock holder, which cannot vouch
          // for itself.
          const checkLive = run(
            (poolSql) => poolSql`
              select
                exists (
                  select 1 from pg_locks
                  where locktype = 'advisory'
                    and pid = ${lockPid}
                    and objsubid = 1
                    and granted
                    -- pg_locks splits the 64-bit advisory key into two
                    -- int4 halves; reassembling them with << 32 relies on
                    -- bigint wraparound matching hashtextextended's signed
                    -- 64-bit result, which is exact for all inputs.
                    and ((classid::bigint << 32) | (objid::bigint & 4294967295))
                      = hashtextextended(${key}, 0)
                ) as live,
                pg_backend_pid() as checker_pid
            `,
          ).pipe(
            Effect.flatMap((rows) => {
              const row = rows[0];
              if (Number(row?.checker_pid) === lockPid) {
                return Effect.fail(
                  new StateStoreError({
                    message: `the Postgres state lock '${key}' cannot be verified: the check ran on the same backend (pid ${lockPid}) that holds the lock, so this client is not pool-backed; pass postgresState a connection pool`,
                  }),
                );
              }
              return row?.live === true
                ? Effect.void
                : Effect.fail(
                    new StateStoreError({
                      message: `the Postgres state lock '${key}' was lost mid-run; refusing to continue unlocked`,
                    }),
                  );
            }),
          );

          return { checkLive: amortizeCheck(checkLive, ttlMs) };
        }),
      );

    // One lease per (stack, stage), acquired lazily on the first operation
    // that touches the pair and cached for the store's lifetime. The mutex
    // makes acquisition single-flight so two concurrent first operations
    // cannot race each other into a self-inflicted contention failure.
    const leaseMutex = Semaphore.makeUnsafe(1);
    const leases = new Map<string, Effect.Effect<Lease, StateStoreError>>();

    const leaseFor = (
      stack: string,
      stage: string,
    ): Effect.Effect<Lease, StateStoreError> =>
      Semaphore.withPermits(
        leaseMutex,
        1,
      )(
        Effect.gen(function* () {
          const key = lockKey(stack, stage);
          const existing = leases.get(key);
          if (existing !== undefined) return existing;
          const cached = yield* Effect.cached(acquireLease(key));
          leases.set(key, cached);
          return cached;
        }),
      ).pipe(Effect.flatMap((lease) => lease));

    /**
     * Every storage operation on a `(stack, stage)` first ensures this
     * store holds the pair's advisory lock and that the lease is still
     * live. Reads are guarded too, not just writes: a lost lease means a
     * concurrent deploy may already be mutating these rows, so a read could
     * return stale or conflicting data.
     */
    const guarded = <A>(
      request: { stack: string; stage: string },
      op: Effect.Effect<A, StateStoreError>,
    ): Effect.Effect<A, StateStoreError> =>
      leaseFor(request.stack, request.stage).pipe(
        Effect.flatMap((lease) => lease.checkLive),
        Effect.andThen(op),
      );

    // Operations without a stage cannot name a single lease, so they
    // re-verify every lease this store currently holds instead.
    const verifyHeldLeases: Effect.Effect<void, StateStoreError> =
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(leases.values()),
          (lease) => lease.pipe(Effect.flatMap((held) => held.checkLive)),
          { discard: true },
        ),
      );

    const jsonParam = (value: unknown) => JSON.stringify(encodeState(value));

    const deleteStage = (stack: string, stage: string) =>
      run(
        (sql) =>
          sql`delete from alchemy_resource_state where stack = ${stack} and stage = ${stage}`,
      ).pipe(
        Effect.andThen(
          run(
            (sql) =>
              sql`delete from alchemy_stack_output where stack = ${stack} and stage = ${stage}`,
          ),
        ),
        Effect.asVoid,
      );

    const service: StateService = {
      id: options.id ?? "postgres",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        verifyHeldLeases.pipe(
          Effect.andThen(
            run(
              (sql) =>
                sql`select stack from alchemy_resource_state union select stack from alchemy_stack_output order by stack`,
            ),
          ),
          Effect.map((rows) => rows.map((row) => String(row.stack))),
        ),
      listStages: (stack) =>
        verifyHeldLeases.pipe(
          Effect.andThen(
            run(
              (sql) =>
                sql`select stage from alchemy_resource_state where stack = ${stack} union select stage from alchemy_stack_output where stack = ${stack} order by stage`,
            ),
          ),
          Effect.map((rows) => rows.map((row) => String(row.stage))),
        ),
      get: (request) =>
        guarded(
          request,
          run(
            (sql) =>
              sql`select value from alchemy_resource_state where stack = ${request.stack} and stage = ${request.stage} and fqn = ${request.fqn}`,
          ).pipe(
            Effect.map((rows) => {
              const row = rows[0];
              // Every row was written by `set` through `encodeState`, so
              // reviving it recovers a PersistedState by construction.
              return row === undefined
                ? undefined
                : (reviveStateRecursive(row.value) as PersistedState);
            }),
          ),
        ),
      // Filters by status directly in SQL rather than listing FQNs and
      // re-fetching each one — same semantics as LocalState, without the
      // N+1 round-trips.
      getReplacedResources: (request) =>
        guarded(
          request,
          run(
            (sql) =>
              sql`select value from alchemy_resource_state where stack = ${request.stack} and stage = ${request.stage} and value ->> 'status' = 'replaced'`,
          ).pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  reviveStateRecursive(row.value) as ReplacedResourceState,
              ),
            ),
          ),
        ),
      set: (request) =>
        guarded(
          request,
          run(
            (sql) => sql`
              insert into alchemy_resource_state (stack, stage, fqn, value, updated_at)
              values (${request.stack}, ${request.stage}, ${request.fqn}, ${jsonParam(request.value)}::jsonb, now())
              on conflict (stack, stage, fqn) do update
                set value = excluded.value, updated_at = excluded.updated_at
            `,
          ).pipe(Effect.map(() => request.value)),
        ),
      delete: (request) =>
        guarded(
          request,
          run(
            (sql) =>
              sql`delete from alchemy_resource_state where stack = ${request.stack} and stage = ${request.stage} and fqn = ${request.fqn}`,
          ).pipe(Effect.asVoid),
        ),
      // Deleting a whole stack first acquires the advisory lock for every
      // stage it is about to remove, so a concurrent deploy of any stage
      // fails the lock instead of racing the delete. The stack-wide sweep
      // that follows runs while all of those stage locks are still held.
      deleteStack: ({ stack, stage }) =>
        stage === undefined
          ? verifyHeldLeases.pipe(
              Effect.andThen(service.listStages(stack)),
              Effect.flatMap((stages) =>
                Effect.forEach(
                  stages,
                  (found) =>
                    guarded({ stack, stage: found }, deleteStage(stack, found)),
                  { discard: true },
                ),
              ),
              Effect.andThen(
                run(
                  (sql) =>
                    sql`delete from alchemy_resource_state where stack = ${stack}`,
                ),
              ),
              Effect.andThen(
                run(
                  (sql) =>
                    sql`delete from alchemy_stack_output where stack = ${stack}`,
                ),
              ),
              Effect.asVoid,
            )
          : guarded({ stack, stage }, deleteStage(stack, stage)),
      list: (request) =>
        guarded(
          request,
          run(
            (sql) =>
              sql`select fqn from alchemy_resource_state where stack = ${request.stack} and stage = ${request.stage} order by fqn`,
          ).pipe(Effect.map((rows) => rows.map((row) => String(row.fqn)))),
        ),
      getOutput: (request) =>
        guarded(
          request,
          run(
            (sql) =>
              sql`select value from alchemy_stack_output where stack = ${request.stack} and stage = ${request.stage}`,
          ).pipe(
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? undefined
                : reviveStateRecursive(row.value);
            }),
          ),
        ),
      setOutput: (request) =>
        guarded(
          request,
          run(
            (sql) => sql`
              insert into alchemy_stack_output (stack, stage, value, updated_at)
              values (${request.stack}, ${request.stage}, ${jsonParam(request.value)}::jsonb, now())
              on conflict (stack, stage) do update
                set value = excluded.value, updated_at = excluded.updated_at
            `,
          ).pipe(Effect.map(() => request.value)),
        ),
    };
    return service;
  });
