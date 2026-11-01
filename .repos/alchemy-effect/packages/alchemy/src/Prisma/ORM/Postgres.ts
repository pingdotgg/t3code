// The Prisma runtime peers are loaded on first use. This module is not
// re-exported from `alchemy/Prisma`; import `alchemy/Prisma/ORM/Postgres`.
import type { SqlStorage } from "@prisma/orm-postgres/family-contract/types";
import type { Contract } from "@prisma/orm-postgres/contract/types";
import type {
  Runtime,
  RuntimeConnection,
  RuntimeTransaction,
} from "@prisma/orm-postgres/family-runtime";
import type {
  SqlExecutionPlan,
  SqlQueryPlan,
} from "@prisma/orm-postgres/relational-core/plan";
import type {
  PostgresClient,
  PostgresOptionsBase,
} from "@prisma/orm-postgres/runtime";
import type { PostgresStaticContext } from "@prisma/orm-postgres/static";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { makeExecutionMemo } from "../../Runtime/ExecutionMemo.ts";
import { type ClientError, RollbackError, wrapPrismaError } from "./Errors.ts";
import { type EffectOrm, makeOrmProxy } from "./OrmClient.ts";
import { type Prepare, makePrepare } from "./Prepared.ts";
export type {
  Prepare,
  Prepared,
  PreparedQuery,
  PreparedMutation,
} from "./Prepared.ts";

export * from "./Errors.ts";
export type { EffectCollection, EffectOrm, WhereFilter } from "./OrmClient.ts";

/** A Prisma Postgres contract, authored directly or described by emitted types. */
export type AnyPostgresContract = Contract<SqlStorage>;

/** A plan produced by the `sql` builder lane (`db.sql...build()`) or `raw`. */
export type Plan<Row> = SqlQueryPlan<Row> | SqlExecutionPlan<Row>;

export type PostgresConfig<C extends AnyPostgresContract> =
  PostgresOptionsBase &
    (
      | {
          /** The TypeScript contract returned by Prisma's `defineContract`. */
          readonly contract: C;
          readonly contractJson?: never;
        }
      | {
          /** Canonical JSON paired with Prisma's emitted Contract declaration. */
          readonly contractJson: unknown;
          readonly contract?: never;
        }
    );

/**
 * The transaction scope handed to {@link PostgresDatabase.transaction}'s
 * callback: the same `orm`/`execute` surfaces bound to the open
 * transaction, plus a typed `rollback`.
 */
export interface PostgresTransaction<C extends AnyPostgresContract> {
  /** The orm lane, executing on this transaction's connection. */
  readonly orm: EffectOrm<C>;
  /** Run a `sql`-lane or `raw` plan on this transaction's connection. */
  execute<Row>(plan: Plan<Row>): Effect.Effect<Row[], ClientError>;
  /** Prepare a typed statement whose executions use this transaction. */
  readonly prepare: Prepare<C>;
  /**
   * Abort the transaction: rolls back and fails the `transaction` effect
   * with {@link RollbackError} (catchable by tag).
   */
  rollback(): Effect.Effect<never, RollbackError>;
}

export interface PostgresDatabase<
  C extends AnyPostgresContract,
  E = never,
  R = never,
> {
  /**
   * The native Prisma client for the current execution. Prefer the Effect
   * methods for typed failures and repeatable execution.
   */
  readonly client: Effect.Effect<PostgresClient<C>, E, R>;
  /**
   * Run promise-land code against the execution's client:
   *
   * ```typescript
   * const rows = yield* db.use((c) => c.orm.public.User.groupBy(...)...);
   * ```
   */
  readonly use: <A>(
    f: (client: PostgresClient<C>) => PromiseLike<A>,
  ) => Effect.Effect<A, ClientError | E, R>;
  /**
   * The Effect-native orm lane — chain like Prisma, yield the terminal:
   *
   * ```typescript
   * const user = yield* db.orm.public.User.where({ email }).include("posts").first();
   * ```
   */
  readonly orm: EffectOrm<C, ClientError | E, R>;
  /**
   * The pure `sql` builder lane (no connection — plans are data):
   * `db.sql.public.user.select("id", "email").build()`.
   */
  readonly sql: PostgresStaticContext<C>["sql"];
  /** The raw SQL lane (pure): ``db.raw.sql`SELECT ...` `` builds plans. */
  readonly raw: PostgresStaticContext<C>["raw"];
  /** Execute a plan, buffering all rows. */
  execute<Row>(plan: Plan<Row>): Effect.Effect<Row[], ClientError | E, R>;
  /** Execute a plan as a row stream (each run re-executes the plan). */
  stream<Row>(plan: Plan<Row>): Stream.Stream<Row, ClientError | E, R>;
  /** Prepare a typed statement; each query resolves the current execution's client. */
  readonly prepare: Prepare<C, E, R>;
  /**
   * Run `f` inside a database transaction on a dedicated connection.
   * Commits on success; rolls back on failure or interruption. Yield
   * `tx.rollback()` to abort with a typed {@link RollbackError}.
   */
  transaction<A, E2, R2>(
    f: (tx: PostgresTransaction<C>) => Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E2 | ClientError | E, R | R2>;
}

/**
 * Open a Prisma ORM v8 Postgres client from a connection URL, with
 * Effect-native query surfaces over Prisma's own builders and engine.
 *
 * The client is built at most once per execution — a Worker
 * `fetch`/`queue`/`scheduled` event, a Durable Object call, a Workflow run,
 * or a Lambda invocation — and memoized on the execution's `Scope` (via
 * {@link makeExecutionMemo}), with `close()` registered as a scope finalizer
 * so the underlying `pg` pool never outlives its event. That per-execution
 * lifecycle is what makes the client safe on workerd, where sockets are
 * pinned to the creating request's IoContext. Construction does no I/O
 * (Prisma connects lazily on the first query), so deploy/plan-time
 * evaluations never touch the database.
 *
 * Model types infer directly from the native TypeScript contract, together
 * with the connection source's error and requirement channels. No generated
 * application imports are required. For Prisma rc.11, author contracts with
 * `defineContract` from `alchemy/Prisma/ORM` to retain metadata
 * lost by the upstream declarations. It uses Prisma's native runtime builders.
 *
 *
 * ```typescript
 * import * as PrismaPostgres from "alchemy/Prisma/ORM/Postgres";
 * import { contract } from "./prisma/contract.ts";
 *
 * const connection = yield* Cloudflare.Hyperdrive.Connect(hyperdrive);
 * const db = yield* PrismaPostgres.Postgres(
 *   connection.connectionString,
 *   { contract },
 * );
 *
 * fetch: Effect.gen(function* () {
 *   // orm lane — queries ARE Effects, with typed errors
 *   const user = yield* db.orm.public.User.where({ email }).include("posts").first();
 *   const made = yield* db.orm.public.Post.create({ title, authorId: user.id });
 *
 *   // sql builder lane — pure plans, Effect executor
 *   const rows = yield* db.execute(db.sql.public.user.select("id", "email").build());
 *
 *   // transactions — commit on success, rollback on failure/interrupt
 *   yield* db.transaction((tx) =>
 *     Effect.gen(function* () {
 *       const u = yield* tx.orm.public.User.create({ email });
 *       if (!u) return yield* tx.rollback();
 *       return u;
 *     }),
 *   );
 * });
 * ```
 *
 * ### PSL Contracts
 * **Example:** Use a generated contract-bound factory
 * ```typescript
 * import { makeDatabase } from "./prisma/generated/client.ts";
 * const db = yield* makeDatabase(connection.connectionString);
 * const users = yield* db.orm.public.User.select("id", "email").all();
 * ```
 *
 * Run `alchemy prisma generate` with `withEffect` registered in the ORM
 * configuration. The factory delegates to this runtime with Prisma's emitted
 * `Contract` type and `contractJson`; query behavior and cleanup are identical.
 * Generated `schemas.ts` can be imported independently of this client.
 *
 * ### Prepared Queries
 * **Example:** Reuse a query with typed parameters
 * ```typescript
 * const findUser = yield* db.prepare({ email: "pg/text@1" }, (sql, params) =>
 *   sql.public.user
 *     .select("id", "email")
 *     .where((fields, fns) => fns.eq(fields.email, params.email))
 *     .build(),
 * );
 * const users = yield* findUser.query({ email: "alice@example.com" });
 * const rows = findUser.query({ email: "alice@example.com" }).stream;
 * ```
 *
 * Prepared queries resolve the current execution's client for each run. Inside
 * `db.transaction`, `tx.prepare` binds executions to that transaction instead.
 * An affected-count plan returns a prepared mutation with `execute(params)`;
 * a row-returning plan returns a prepared query with `query(params)`.
 *
 * The Stream surfaces use Prisma's async iterators. The long-lived Postgres
 * driver buffers raw results, so these streams do not guarantee bounded memory.
 *
 * Queries are lazy and re-runnable: each evaluation replays the chain
 * against the execution's client, so `Effect.retry` re-issues the query.
 * Failures surface as granular tagged errors: the SQL-standard integrity
 * violations each get their own tag (`Prisma.UniqueViolationError`,
 * `Prisma.ForeignKeyViolationError`, `Prisma.NotNullViolationError`,
 * `Prisma.CheckViolationError`), other statement failures are
 * `Prisma.QueryError` (with the normalized `sqlState`), connection
 * failures are `Prisma.ConnectionError` (with the driver's
 * `transient` verdict), and Prisma's structured codes split by
 * category into `Prisma.OrmError` / `Prisma.RuntimeError`
 * with an autocompleting `code` field.
 *
 * @binding
 * @category ORM
 */
export const Postgres = <C extends AnyPostgresContract, E = never, R = never>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config: PostgresConfig<C>,
): Effect.Effect<PostgresDatabase<C, E, R>> =>
  Effect.gen(function* () {
    const { contract, contractJson, ...options } = config;
    const [{ default: postgres }, { default: postgresStatic }, { orm }] =
      yield* Effect.promise(() =>
        Promise.all([
          import("@prisma/orm-postgres/runtime"),
          import("@prisma/orm-postgres/static"),
          import("@prisma/orm-postgres/orm-client"),
        ]),
      );

    // Pure static context: the typed sql/raw builders and the codec
    // machinery, with no driver and no connection behind them.
    const statics = postgresStatic<C>({
      contractJson: contract ?? contractJson,
      ...(options.extensions === undefined
        ? {}
        : { extensions: options.extensions }),
    });

    const client = yield* makeExecutionMemo(
      Effect.gen(function* () {
        const url = Redacted.value(yield* connectionString);
        const instance =
          contract === undefined
            ? postgres<C>({ contractJson, url, ...options })
            : postgres({ contract, url, ...options });
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise(() => instance.close()).pipe(Effect.ignore),
        );
        return instance;
      }),
    );

    const execute = <Row>(
      plan: Plan<Row>,
    ): Effect.Effect<Row[], ClientError | E, R> =>
      Effect.flatMap(client, (c) =>
        Effect.tryPromise({
          try: (signal) => c.runtime().query(plan, { signal }).toArray(),
          catch: wrapPrismaError,
        }),
      );

    const stream = <Row>(
      plan: Plan<Row>,
    ): Stream.Stream<Row, ClientError | E, R> =>
      // unwrap re-evaluates per run, so each run gets a fresh
      // AsyncIterableResult (they are single-consumption).
      Stream.unwrap(
        Effect.map(client, (c) =>
          Stream.fromAsyncIterable(
            c.runtime().query(plan) as AsyncIterable<Row>,
            wrapPrismaError,
          ),
        ),
      );

    const makeTransactionScope = (
      txn: RuntimeTransaction,
      runtime: Runtime,
    ) => {
      const txOrm = orm<C>({
        runtime: txn,
        context: statics.context,
      });
      const tx: PostgresTransaction<C> = {
        orm: makeOrmProxy<C, never, never>(Effect.sync(() => txOrm)),
        prepare: makePrepare(
          Effect.succeed(runtime),
          statics.sql,
          Effect.succeed(txn),
        ),
        execute: <Row>(plan: Plan<Row>) =>
          Effect.tryPromise({
            try: (signal) => txn.query(plan, { signal }).toArray(),
            catch: wrapPrismaError,
          }),
        rollback: () => Effect.fail(new RollbackError()),
      };
      return tx;
    };

    const transaction = <A, E2, R2>(
      f: (tx: PostgresTransaction<C>) => Effect.Effect<A, E2, R2>,
    ): Effect.Effect<A, E2 | ClientError | E, R | R2> =>
      Effect.flatMap(client, (c) =>
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: async () => {
              const connection: RuntimeConnection = await c
                .runtime()
                .connection();
              try {
                const txn = await connection.transaction();
                return { connection, txn, committed: false };
              } catch (error) {
                await connection.destroy(error).catch(() => {});
                throw error;
              }
            },
            catch: wrapPrismaError,
          }),
          (scope) =>
            f(makeTransactionScope(scope.txn, c.runtime())).pipe(
              Effect.flatMap((value) =>
                Effect.tryPromise({
                  try: async () => {
                    await scope.txn.commit();
                    scope.committed = true;
                    return value;
                  },
                  catch: wrapPrismaError,
                }),
              ),
            ),
          (scope) =>
            // Rollback on any non-committed exit (failure, interrupt, or
            // commit failure), then return the connection to the pool —
            // destroying it if cleanup itself failed.
            Effect.promise(async () => {
              try {
                if (!scope.committed) await scope.txn.rollback();
                await scope.connection.release();
              } catch (error) {
                await scope.connection.destroy(error).catch(() => {});
              }
            }),
        ),
      );

    const db: PostgresDatabase<C, E, R> = {
      client,
      use: (f) =>
        Effect.flatMap(client, (c) =>
          Effect.tryPromise({
            try: () => Promise.resolve(f(c)),
            catch: wrapPrismaError,
          }),
        ),
      orm: makeOrmProxy<C, ClientError | E, R>(
        Effect.map(client, (c) => c.orm),
      ),
      sql: statics.sql,
      raw: statics.raw,
      prepare: makePrepare(
        Effect.map(client, (c) => c.runtime()),
        statics.sql,
      ),
      execute,
      stream,
      transaction,
    };
    return db;
  });
