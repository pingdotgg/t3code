import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { flushDurableObjectAlarm } from "./DurableObjectAlarmStorage.ts";
import {
  ActiveStorageTransactions,
  type ActiveStorageTransaction,
} from "./DurableObjectTransactionContext.ts";

/** A native transaction failure or invalid use of a transaction's owner. */
export class DurableObjectStorageError extends Data.TaggedError(
  "DurableObjectStorageError",
)<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Pre-existing sibling fibers do not inherit the transaction's context.
const activeStorageTransactions = new WeakMap<
  cf.DurableObjectStorage,
  ActiveStorageTransaction
>();

const checkTransactionOwner = (
  transaction: ActiveStorageTransaction,
  allowRolledBack = false,
) =>
  Effect.withFiber((fiber) =>
    transaction.active &&
    transaction.owner === fiber &&
    (allowRolledBack || !transaction.rolledBack)
      ? Effect.void
      : Effect.fail(
          new DurableObjectStorageError({
            operation: "transaction",
            message: !transaction.active
              ? "The storage transaction callback has already finished"
              : transaction.owner !== fiber
                ? "A storage transaction cannot be used by another fiber"
                : "The storage transaction has been rolled back",
          }),
        ),
  );

/** @internal Joins an owned transaction, or starts a native transaction. */
function withStorageTransaction<A, E, R>(
  storage: cf.DurableObjectStorage,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DurableObjectStorageError, R>;
function withStorageTransaction<A, E, R>(
  storage: cf.DurableObjectStorage,
  closure: (txn: DurableObjectTransaction) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DurableObjectStorageError, R>;
function withStorageTransaction<A, E, R>(
  storage: cf.DurableObjectStorage,
  body:
    | Effect.Effect<A, E, R>
    | ((txn: DurableObjectTransaction) => Effect.Effect<A, E, R>),
): Effect.Effect<A, E | DurableObjectStorageError, R> {
  return Effect.gen(function* () {
    const transactions = yield* ActiveStorageTransactions;
    const existing =
      transactions.get(storage) ?? activeStorageTransactions.get(storage);
    const evaluate = (transaction: ActiveStorageTransaction) =>
      Effect.suspend(() =>
        typeof body === "function"
          ? body(
              makeDurableObjectTransaction(
                transaction.transaction,
                checkTransactionOwner(transaction).pipe(Effect.orDie),
                checkTransactionOwner(transaction, true).pipe(
                  Effect.andThen(() =>
                    Effect.sync(() => {
                      if (!transaction.rolledBack) {
                        transaction.transaction.rollback();
                        transaction.rolledBack = true;
                      }
                    }),
                  ),
                  Effect.orDie,
                ),
                flushDurableObjectAlarm(storage),
              ),
            )
          : body,
      );

    if (existing !== undefined) {
      yield* checkTransactionOwner(existing);
      return yield* evaluate(existing);
    }

    const context = yield* Effect.context<R>();
    // Native input gates can block timers; fiber yields must use microtasks.
    const scheduler = new Scheduler.MixedScheduler("sync");

    return yield* Effect.scoped(
      Effect.gen(function* () {
        let cancelled = false;
        let callbackFiber: Fiber.Fiber<A, E> | undefined;
        let native: Promise<A> | undefined;
        let failure: Exit.Failure<A, E> | undefined;
        let currentTransaction: ActiveStorageTransaction | undefined;
        const release = () => {
          if (currentTransaction !== undefined) {
            currentTransaction.active = false;
            if (activeStorageTransactions.get(storage) === currentTransaction) {
              activeStorageTransactions.delete(storage);
            }
          }
        };

        yield* Effect.addFinalizer(
          Effect.fn(function* () {
            cancelled = true;
            if (callbackFiber !== undefined) {
              yield* Fiber.interrupt(callbackFiber);
            }
            const settlement = native;
            if (settlement !== undefined) {
              // The callback must finish before waiting for native rollback.
              yield* Effect.promise(() =>
                settlement.then(
                  () => undefined,
                  () => undefined,
                ),
              );
            }
          }),
        );

        return yield* Effect.callback<A, E | DurableObjectStorageError>(
          (resume) => {
            const reject = (cause: unknown) => {
              release();
              resume(
                failure !== undefined && cause === failure
                  ? Effect.failCause(failure.cause)
                  : Effect.fail(
                      new DurableObjectStorageError({
                        operation: "transaction",
                        message: "The native storage transaction failed",
                        cause,
                      }),
                    ),
              );
            };

            try {
              native = storage.transaction((txn) => {
                if (cancelled) {
                  throw new DurableObjectStorageError({
                    operation: "transaction",
                    message: "The storage transaction caller was interrupted",
                  });
                }
                const transaction: ActiveStorageTransaction = {
                  transaction: txn,
                  owner: undefined,
                  active: true,
                  rolledBack: false,
                  alarmTablesEnsured: false,
                  alarmDirty: false,
                };
                currentTransaction = transaction;
                activeStorageTransactions.set(storage, transaction);
                const callbackContext = Context.add(
                  context,
                  ActiveStorageTransactions,
                  new Map(transactions).set(storage, transaction),
                );

                return new Promise<A>((resolve, rejectCallback) => {
                  callbackFiber = Effect.runForkWith(callbackContext)(
                    Effect.withFiber((fiber) => {
                      transaction.owner = fiber;
                      return evaluate(transaction).pipe(
                        Effect.scoped,
                        Effect.tap(() => flushDurableObjectAlarm(storage)),
                      );
                    }),
                    { scheduler },
                  );
                  callbackFiber.addObserver((exit) => {
                    transaction.active = false;
                    if (Exit.isSuccess(exit)) {
                      resolve(exit.value);
                    } else {
                      failure = exit;
                      rejectCallback(exit);
                    }
                  });
                });
              });
              native.then((value) => {
                release();
                resume(Effect.succeed(value));
              }, reject);
            } catch (cause) {
              reject(cause);
            }
          },
        );
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// SqlStorage — Effect-native wrapper around cf.SqlStorage
// ---------------------------------------------------------------------------

export type SqlStorageValue = cf.SqlStorageValue;

export interface SqlCursor<
  T extends Record<string, SqlStorageValue>,
> extends Stream.Stream<T> {
  next(): Effect.Effect<
    { done?: false; value: T } | { done: true; value?: never },
    never,
    RuntimeContext
  >;
  toArray(): Effect.Effect<T[], never, RuntimeContext>;
  one(): Effect.Effect<T, never, RuntimeContext>;
  raw<U extends SqlStorageValue[]>(): Stream.Stream<U, never, RuntimeContext>;
  readonly columnNames: string[];
  readonly rowsRead: Effect.Effect<number, never, RuntimeContext>;
  readonly rowsWritten: Effect.Effect<number, never, RuntimeContext>;
}

export interface SqlStorage {
  /**
   * The raw underlying Cloudflare SqlStorage binding.
   *
   * Use this when you need direct access for libraries that already support
   * Cloudflare Durable Object SQLite storage.
   */
  readonly raw: cf.SqlStorage;
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: any[]
  ): Effect.Effect<SqlCursor<T>, never, RuntimeContext>;
  readonly databaseSize: number;
}

const fromSqlCursor = <T extends Record<string, SqlStorageValue>>(
  cursor: cf.SqlStorageCursor<T>,
): SqlCursor<T> => {
  const stream = Stream.fromIterableEffect(Effect.sync(() => cursor));
  return Object.assign(stream, {
    next: () => Effect.sync(() => cursor.next()),
    toArray: () => Effect.sync(() => cursor.toArray()),
    one: () => Effect.sync(() => cursor.one()),
    raw: <U extends SqlStorageValue[]>() =>
      Stream.fromIterableEffect(Effect.sync(() => cursor.raw<U>())),
    get columnNames() {
      return cursor.columnNames;
    },
    rowsRead: Effect.sync(() => cursor.rowsRead),
    rowsWritten: Effect.sync(() => cursor.rowsWritten),
  }) as SqlCursor<T>;
};

const fromSqlStorage = (
  sql: cf.SqlStorage,
  checkOwner: Effect.Effect<void>,
): SqlStorage => ({
  raw: sql,
  exec: <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: any[]
  ): Effect.Effect<SqlCursor<T>> =>
    Effect.andThen(
      checkOwner,
      Effect.sync(() => fromSqlCursor(sql.exec<T>(query, ...bindings))),
    ),
  get databaseSize() {
    return sql.databaseSize;
  },
});

// ---------------------------------------------------------------------------
// DurableObjectTransaction
// ---------------------------------------------------------------------------

export interface DurableObjectTransaction {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined, never, RuntimeContext>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean, never, RuntimeContext>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number, never, RuntimeContext>;
  rollback(): Effect.Effect<void, never, RuntimeContext>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null, never, RuntimeContext>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  deleteAlarm(
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
}

// ---------------------------------------------------------------------------
// DurableObjectStorage
// ---------------------------------------------------------------------------

export interface DurableObjectStorage {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined, never, RuntimeContext>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>, never, RuntimeContext>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean, never, RuntimeContext>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number, never, RuntimeContext>;
  deleteAll(
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Run an Effect inside a native storage transaction with the caller's context.
   * On SQLite-backed storage, SQL, KV, and alarm writes to this storage commit
   * together. Typed failures, defects, and interruption roll back the transaction.
   * Interruption waits for the callback fiber and native rollback to finish.
   * Nested calls on the same fiber join the active transaction; transaction
   * handles cannot be used by another fiber or after the callback finishes.
   */
  transaction<A, E = never, R = never>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DurableObjectStorageError, R | RuntimeContext>;
  transaction<A, E = never, R = never>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DurableObjectStorageError, R | RuntimeContext>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null, never, RuntimeContext>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  deleteAlarm(
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
  sync(): Effect.Effect<void, never, RuntimeContext>;
  sql: SqlStorage;
  kv: cf.SyncKvStorage;
  getCurrentBookmark(): Effect.Effect<string, never, RuntimeContext>;
  getBookmarkForTime(
    timestamp: number | Date,
  ): Effect.Effect<string, never, RuntimeContext>;
  onNextSessionRestoreBookmark(
    bookmark: string,
  ): Effect.Effect<string, never, RuntimeContext>;
}

// ---------------------------------------------------------------------------
// Constructors from raw Cloudflare types
// ---------------------------------------------------------------------------

export const fromDurableObjectTransaction = (
  txn: cf.DurableObjectTransaction,
): DurableObjectTransaction => makeDurableObjectTransaction(txn, Effect.void);

const makeDurableObjectTransaction = (
  txn: cf.DurableObjectTransaction,
  checkOwner: Effect.Effect<void>,
  rollback = Effect.andThen(
    checkOwner,
    Effect.sync(() => txn.rollback()),
  ),
  flushAlarm: Effect.Effect<void> = Effect.void,
): DurableObjectTransaction => {
  const use = <A>(effect: Effect.Effect<A>) =>
    Effect.andThen(checkOwner, effect);
  const useAlarm = <A>(effect: Effect.Effect<A>) =>
    use(Effect.andThen(flushAlarm, effect));

  return {
    get: ((
      keyOrKeys: string | string[],
      options?: cf.DurableObjectGetOptions,
    ) => use(Effect.promise(() => txn.get(keyOrKeys as any, options)))) as any,
    list: (options?: cf.DurableObjectListOptions) =>
      use(Effect.promise(() => txn.list(options))),
    put: ((
      keyOrEntries: string | Record<string, unknown>,
      valueOrOptions?: unknown,
      maybeOptions?: cf.DurableObjectPutOptions,
    ) =>
      use(
        typeof keyOrEntries === "string"
          ? Effect.promise(() =>
              txn.put(keyOrEntries, valueOrOptions, maybeOptions),
            )
          : Effect.promise(() =>
              txn.put(
                keyOrEntries,
                valueOrOptions as cf.DurableObjectPutOptions | undefined,
              ),
            ),
      )) as any,
    delete: ((
      keyOrKeys: string | string[],
      options?: cf.DurableObjectPutOptions,
    ) =>
      use(Effect.promise(() => txn.delete(keyOrKeys as any, options)))) as any,
    rollback: () => rollback,
    getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
      useAlarm(Effect.promise(() => txn.getAlarm(options))),
    setAlarm: (
      scheduledTime: number | Date,
      options?: cf.DurableObjectSetAlarmOptions,
    ) => useAlarm(Effect.promise(() => txn.setAlarm(scheduledTime, options))),
    deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
      useAlarm(Effect.promise(() => txn.deleteAlarm(options))),
  };
};

export const fromDurableObjectStorage = (
  storage: cf.DurableObjectStorage,
): DurableObjectStorage => {
  const checkOwner = Effect.withFiber((fiber) => {
    const transaction =
      fiber.getRef(ActiveStorageTransactions).get(storage) ??
      activeStorageTransactions.get(storage);
    return transaction === undefined
      ? Effect.void
      : checkTransactionOwner(transaction).pipe(Effect.orDie);
  });
  const use = <A>(effect: Effect.Effect<A>) =>
    Effect.andThen(checkOwner, effect);
  const useAlarm = <A>(effect: Effect.Effect<A>) =>
    use(Effect.andThen(flushDurableObjectAlarm(storage), effect));

  return {
    get: ((
      keyOrKeys: string | string[],
      options?: cf.DurableObjectGetOptions,
    ) =>
      use(Effect.promise(() => storage.get(keyOrKeys as any, options)))) as any,
    list: (options?: cf.DurableObjectListOptions) =>
      use(Effect.promise(() => storage.list(options))),
    put: ((
      keyOrEntries: string | Record<string, unknown>,
      valueOrOptions?: unknown,
      maybeOptions?: cf.DurableObjectPutOptions,
    ) =>
      use(
        typeof keyOrEntries === "string"
          ? Effect.promise(() =>
              storage.put(keyOrEntries, valueOrOptions, maybeOptions),
            )
          : Effect.promise(() =>
              storage.put(
                keyOrEntries,
                valueOrOptions as cf.DurableObjectPutOptions | undefined,
              ),
            ),
      )) as any,
    delete: ((
      keyOrKeys: string | string[],
      options?: cf.DurableObjectPutOptions,
    ) =>
      use(
        Effect.promise(() => storage.delete(keyOrKeys as any, options)),
      )) as any,
    deleteAll: (options?: cf.DurableObjectPutOptions) =>
      use(Effect.promise(() => storage.deleteAll(options))),
    transaction: <A, E, R>(
      body:
        | Effect.Effect<A, E, R>
        | ((txn: DurableObjectTransaction) => Effect.Effect<A, E, R>),
    ) =>
      withStorageTransaction(storage, (txn) =>
        typeof body === "function" ? body(txn) : body,
      ),
    getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
      useAlarm(Effect.promise(() => storage.getAlarm(options))),
    setAlarm: (
      scheduledTime: number | Date,
      options?: cf.DurableObjectSetAlarmOptions,
    ) =>
      useAlarm(Effect.promise(() => storage.setAlarm(scheduledTime, options))),
    deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
      useAlarm(Effect.promise(() => storage.deleteAlarm(options))),
    sync: () => use(Effect.promise(() => storage.sync())),
    sql: fromSqlStorage(storage.sql, checkOwner),
    kv: storage.kv,
    getCurrentBookmark: () =>
      use(Effect.promise(() => storage.getCurrentBookmark())),
    getBookmarkForTime: (timestamp: number | Date) =>
      use(Effect.promise(() => storage.getBookmarkForTime(timestamp))),
    onNextSessionRestoreBookmark: (bookmark: string) =>
      use(Effect.promise(() => storage.onNextSessionRestoreBookmark(bookmark))),
  };
};
