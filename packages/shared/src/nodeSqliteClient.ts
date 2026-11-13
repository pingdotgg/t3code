import * as NodeSqlite from "node:sqlite";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import type { Acquired, ConnectionOwner, SqliteClientConfig } from "./nodeSqliteClientPart2.ts";
import { ATTR_DB_SYSTEM_NAME, UnsupportedNodeSqliteOperationError, annotateAcquired, checkNodeSqliteCompat, classifyError, connectionOwner, hasLargeBinding, readOnly } from "./nodeSqliteClientPart2.ts";
import { READER_POOL_SIZE, makeReader } from "./nodeSqliteClientPart3.ts";
import { startCheckpointWorker } from "./nodeSqliteClientPart5.ts";
export type { SqliteClientConfig } from "./nodeSqliteClientPart2.ts";
export {
  UnsupportedNodeSqliteOperationError,
  UnsupportedNodeSqliteVersionError,
  readOnly,
} from "./nodeSqliteClientPart2.ts";

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
export const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@t3tools/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

export const TransactionAcquire = Context.Reference<
  | {
      acquired?: Acquired;
      ownerAtWaitStart: ConnectionOwner | undefined;
      restore: typeof Effect.interruptible | undefined;
    }
  | undefined
>("@t3tools/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

export const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite();
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    // Started after the close finalizer, so the worker stops before the writer closes.
    const checkpoint =
      options.checkpointWorker && isFileDatabase
        ? yield* startCheckpointWorker(options.filename, db)
        : undefined;

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    interface CheckpointClassification {
      backpressure: boolean;
      check: boolean;
    }
    const checkpointClassifications = new WeakMap<
      NodeSqlite.StatementSync,
      CheckpointClassification
    >();
    const mutatingPragmasWithValues = new Set([
      "application_id",
      "auto_vacuum",
      "journal_mode",
      "schema_version",
      "user_version",
    ]);
    const mutatesPragma = (name: string | null, value: string | null) => {
      const pragma = name?.toLowerCase();
      if (pragma === undefined) return false;
      if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
      if (pragma === "wal_checkpoint") return value?.toLowerCase() !== "noop";
      return value !== null && mutatingPragmasWithValues.has(pragma);
    };
    let activeClassification: CheckpointClassification | undefined;
    const withClassification = <A>(
      classification: CheckpointClassification | undefined,
      f: () => A,
    ): A => {
      if (classification === undefined) return f();
      const previous = activeClassification;
      activeClassification = classification;
      try {
        return f();
      } finally {
        activeClassification = previous;
      }
    };
    if (checkpoint !== undefined) {
      // SQLite may reprepare an expired statement while it executes. Keep this
      // callback installed and collect only around that statement's prepare/run.
      db.setAuthorizer((actionCode, action, argument) => {
        const classification = activeClassification;
        if (classification === undefined) return NodeSqlite.constants.SQLITE_OK;
        const constants = NodeSqlite.constants;
        if (actionCode === constants.SQLITE_TRANSACTION) {
          classification.backpressure ||= action === "BEGIN";
          classification.check ||= action === "COMMIT" || action === "ROLLBACK";
        } else if (actionCode === constants.SQLITE_SAVEPOINT) {
          classification.backpressure ||= action === "BEGIN";
          classification.check = true;
        } else if (actionCode === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
          classification.backpressure = true;
          classification.check = true;
        } else if (
          actionCode !== constants.SQLITE_READ &&
          actionCode !== constants.SQLITE_SELECT &&
          actionCode !== constants.SQLITE_FUNCTION &&
          actionCode !== constants.SQLITE_RECURSIVE &&
          actionCode !== constants.SQLITE_PRAGMA
        ) {
          classification.backpressure = true;
          classification.check = true;
        }
        return constants.SQLITE_OK;
      });
    }
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => {
          const classification = { backpressure: false, check: false };
          const statement = withClassification(classification, () => db.prepare(sql));
          if (checkpoint !== undefined) checkpointClassifications.set(statement, classification);
          return statement;
        },
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw" | "values" = "rows",
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const classification = checkpointClassifications.get(statement);
        const execute = () => {
          let arrays = false;
          let result: Exit.Exit<ReadonlyArray<unknown>, SqlError>;
          try {
            const value = withClassification(classification, () => {
              statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
              if (hasRows(statement)) {
                arrays = mode === "values";
                if (arrays) statement.setReturnArrays(true);
                return statement.all(...(params as any));
              }
              const result = statement.run(...(params as any));
              return mode === "raw" ? (result as unknown as ReadonlyArray<unknown>) : [];
            });
            result = Exit.succeed(value);
          } catch (cause) {
            result = Exit.fail(
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
            );
          } finally {
            // OR FAIL may have committed earlier rows even when execution throws.
            if (classification?.check) checkpoint?.check();
          }
          if (arrays) {
            try {
              statement.setReturnArrays(false);
            } catch (cause) {
              return Exit.die(
                new SqlError({
                  reason: classifyError(
                    cause,
                    "Failed to reset statement result mode",
                    "resetResultMode",
                  ),
                }),
              );
            }
          }
          return result;
        };
        return checkpoint !== undefined && classification?.backpressure
          ? checkpoint.runWithAdmission(execute)
          : execute();
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, raw ? "raw" : "rows"),
      );
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, "values"),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatement(statement, params ?? [], "values"),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [])),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  // A reader that cannot start turns off the whole pool, so routing never picks a dead slot.
  const readerPool = { unavailable: false };
  const readers =
    options.readerWorker && isFileDatabase
      ? yield* Effect.forEach(Array.from({ length: READER_POOL_SIZE }), () =>
          Effect.map(
            Effect.all([makeReader(options, readerPool), Semaphore.make(1)]),
            ([acquire, lock]) => ({
              acquire,
              lock,
              claims: 0,
            }),
          ),
        )
      : [];

  const writer = { name: "writer" as const, lock: semaphore, connection };
  let activeWriter: ConnectionOwner | undefined;
  // Callers must run route uninterruptibly and pass `claimed` a finalizer that runs `release` once.
  const route = (claimed: (release: Effect.Effect<void>) => Effect.Effect<void>) =>
    Effect.withFiber((fiber) => {
      if (readers.length === 0 || readerPool.unavailable || !Context.get(fiber.context, ReadOnly)) {
        return Effect.succeed(writer);
      }
      // Least claimed wins and ties go to the lowest slot, so idle slots never start a worker.
      let slot = readers[0]!;
      for (const candidate of readers) if (candidate.claims < slot.claims) slot = candidate;
      slot.claims++;
      const reader = slot;
      return Effect.andThen(
        claimed(
          Effect.sync(() => {
            reader.claims--;
          }),
        ),
        Effect.map(reader.acquire, (readerConnection) =>
          readerConnection === undefined
            ? writer
            : { name: "reader" as const, lock: reader.lock, connection: readerConnection },
        ),
      );
    });

  const acquired = (
    target: { readonly name: Acquired["connection"] },
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection: target.name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const writerBorrowBatchSize = 16;
  let writerBorrowsSinceYield = 0;
  const borrower: Borrower = (use) =>
    Effect.uninterruptibleMask((restore) => {
      let release: Effect.Effect<void> = Effect.void;
      const claimed = (next: Effect.Effect<void>) =>
        Effect.sync(() => {
          release = next;
        });
      return Effect.flatMap(route(claimed), (target) => restore(borrowTarget(target, use))).pipe(
        Effect.ensuring(Effect.suspend(() => release)),
      );
    });
  const borrowTarget = <A, E, R>(
    target: {
      readonly name: Acquired["connection"];
      readonly lock: Semaphore.Semaphore;
      readonly connection: Connection;
    },
    use: (connection: Connection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.withFiber((fiber) => {
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const ownerAtWaitStart = target.name === "writer" ? activeWriter : undefined;
      const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
      const useConnection = Effect.suspend(() => {
        if (target.name === "writer") activeWriter = owner;
        if (
          fiber.getRef(References.TracerEnabled) &&
          fiber.getRef(Statement.SpanPropagationEnabled)
        ) {
          annotateAcquired(fiber, acquired(target, clock, start), ownerAtWaitStart);
        }
        return use(target.connection);
      });
      const useOwnedConnection =
        target.name === "writer"
          ? Effect.onExit(useConnection, () =>
              Effect.sync(() => {
                if (activeWriter === owner) activeWriter = undefined;
              }),
            )
          : useConnection;
      if (!options.checkpointWorker || target.name !== "writer") {
        return target.lock.withPermits(1)(useOwnedConnection);
      }
      const writerUse = Effect.onExit(useOwnedConnection, (exit) =>
        Effect.sync(() => {
          writerBorrowsSinceYield = Exit.hasInterrupts(exit)
            ? 0
            : Math.min(writerBorrowsSinceYield + 1, writerBorrowBatchSize);
        }),
      );
      return Effect.flatMap(target.lock.withPermitsIfAvailable(1)(writerUse), (result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : target.lock.withPermits(1)(
              Effect.andThen(
                // Failed SQL also consumes the batch; cancellation hands off immediately.
                Effect.suspend(() => {
                  if (writerBorrowsSinceYield < writerBorrowBatchSize) return Effect.void;
                  writerBorrowsSinceYield = 0;
                  return Effect.callback<void>((resume) => {
                    const immediate = setImmediate(() => resume(Effect.void));
                    return Effect.sync(() => clearImmediate(immediate));
                  });
                }),
                writerUse,
              ),
            ),
      );
    });
  const claimedUntilScopeCloses = (release: Effect.Effect<void>) =>
    Effect.withFiber((fiber) =>
      Scope.addFinalizer(Context.getUnsafe(fiber.context, Scope.Scope), release),
    );
  const transactionAcquirer = Effect.uninterruptible(route(claimedUntilScopeCloses)).pipe(
    Effect.flatMap((target) =>
      Effect.uninterruptibleMask((restore) => {
        const fiber = Fiber.getCurrent()!;
        const scope = Context.getUnsafe(fiber.context, Scope.Scope);
        const clock = fiber.getRef(Clock.Clock);
        const start = clock.monotonicTimeNanosUnsafe();
        const pending = fiber.getRef(TransactionAcquire);
        const ownerAtWaitStart = target.name === "writer" ? activeWriter : undefined;
        const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
        const acquire = Effect.tap((pending?.restore ?? restore)(target.lock.take(1)), () => {
          if (target.name === "writer") activeWriter = owner;
          if (pending !== undefined) {
            pending.acquired = acquired(target, clock, start);
            pending.ownerAtWaitStart = ownerAtWaitStart;
          }
          return Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              if (target.name === "writer" && activeWriter === owner) activeWriter = undefined;
            }).pipe(Effect.andThen(target.lock.release(1))),
          );
        });
        return Effect.as(
          // A scheduler yield after taking the permit must not precede its release finalizer.
          Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
          target.connection,
        );
      }),
    ),
  );

  const client = yield* Client.make({
    driver: "node:sqlite",
    acquirer: transactionAcquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // BEGIN IMMEDIATE avoids read-then-write SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot resolve.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        // SqlClient masks setup; acquisition must preserve the caller's interruptibility.
        const pending: {
          acquired?: Acquired;
          ownerAtWaitStart: ConnectionOwner | undefined;
          restore: typeof Effect.interruptible | undefined;
        } = {
          ownerAtWaitStart: undefined,
          restore,
        };
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired, pending.ownerAtWaitStart);
          pending.restore = undefined;
          return effect;
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
