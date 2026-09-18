import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";

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

const fromSqlStorage = (sql: cf.SqlStorage): SqlStorage => ({
  raw: sql,
  exec: <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: any[]
  ): Effect.Effect<SqlCursor<T>> =>
    Effect.sync(() => fromSqlCursor(sql.exec<T>(query, ...bindings))),
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
   * Run `closure` inside a storage transaction. The closure runs with the
   * caller's full context (services, tracing), as `waitUntil` does, so a
   * service provided to the calling fiber is visible inside the transaction.
   * A defect in the closure rolls the transaction back.
   */
  transaction<T, R = never>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T, never, R>,
  ): Effect.Effect<T, never, R | RuntimeContext>;
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
): DurableObjectTransaction => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.promise(() => txn.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.promise(() => txn.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.promise(() =>
          txn.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.promise(() =>
          txn.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) => Effect.promise(() => txn.delete(keyOrKeys as any, options))) as any,
  rollback: () => Effect.sync(() => txn.rollback()),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.promise(() => txn.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.promise(() => txn.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.promise(() => txn.deleteAlarm(options)),
});

export const fromDurableObjectStorage = (
  storage: cf.DurableObjectStorage,
): DurableObjectStorage => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.promise(() => storage.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.promise(() => storage.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.promise(() =>
          storage.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.promise(() =>
          storage.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) => Effect.promise(() => storage.delete(keyOrKeys as any, options))) as any,
  deleteAll: (options?: cf.DurableObjectPutOptions) =>
    Effect.promise(() => storage.deleteAll(options)),
  transaction: <T, R = never>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T, never, R>,
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      // The failure is typed away as before: a rejected transaction has
      // rolled back, and the rejection reaches the caller as a defect.
      return yield* Effect.promise(() =>
        storage.transaction((txn) =>
          Effect.runPromise(
            closure(fromDurableObjectTransaction(txn)).pipe(
              Effect.provide(context),
            ),
          ),
        ),
      );
    }),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.promise(() => storage.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.promise(() => storage.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.promise(() => storage.deleteAlarm(options)),
  sync: () => Effect.promise(() => storage.sync()),
  sql: fromSqlStorage(storage.sql),
  kv: storage.kv,
  getCurrentBookmark: () => Effect.promise(() => storage.getCurrentBookmark()),
  getBookmarkForTime: (timestamp: number | Date) =>
    Effect.promise(() => storage.getBookmarkForTime(timestamp)),
  onNextSessionRestoreBookmark: (bookmark: string) =>
    Effect.promise(() => storage.onNextSessionRestoreBookmark(bookmark)),
});
