import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// ---------------------------------------------------------------------------
// SqlStorage — Effect-native wrapper around cf.SqlStorage
// ---------------------------------------------------------------------------

export type SqlStorageValue = cf.SqlStorageValue;

export interface SqlCursor<
  T extends Record<string, SqlStorageValue>,
> extends Stream.Stream<T> {
  next(): Effect.Effect<
    { done?: false; value: T } | { done: true; value?: never }
  >;
  toArray(): Effect.Effect<T[]>;
  one(): Effect.Effect<T>;
  raw<U extends SqlStorageValue[]>(): Stream.Stream<U>;
  readonly columnNames: string[];
  readonly rowsRead: Effect.Effect<number>;
  readonly rowsWritten: Effect.Effect<number>;
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
  ): Effect.Effect<SqlCursor<T>>;
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
  ): Effect.Effect<T | undefined>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number>;
  rollback(): Effect.Effect<void>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void>;
  deleteAlarm(options?: cf.DurableObjectSetAlarmOptions): Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// DurableObjectStorage
// ---------------------------------------------------------------------------

export interface DurableObjectStorage {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number>;
  deleteAll(options?: cf.DurableObjectPutOptions): Effect.Effect<void>;
  transaction<T>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T>,
  ): Effect.Effect<T>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void>;
  deleteAlarm(options?: cf.DurableObjectSetAlarmOptions): Effect.Effect<void>;
  sync(): Effect.Effect<void>;
  sql: SqlStorage;
  kv: cf.SyncKvStorage;
  transactionSync<T>(closure: () => T): T;
  getCurrentBookmark(): Effect.Effect<string>;
  getBookmarkForTime(timestamp: number | Date): Effect.Effect<string>;
  onNextSessionRestoreBookmark(bookmark: string): Effect.Effect<string>;
}

// ---------------------------------------------------------------------------
// Constructors from raw Cloudflare types
// ---------------------------------------------------------------------------

export const fromDurableObjectTransaction = (
  txn: cf.DurableObjectTransaction,
): DurableObjectTransaction => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.tryPromise(() => txn.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.tryPromise(() => txn.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.tryPromise(() =>
          txn.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.tryPromise(() =>
          txn.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) => Effect.tryPromise(() => txn.delete(keyOrKeys as any, options))) as any,
  rollback: () => Effect.sync(() => txn.rollback()),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.tryPromise(() => txn.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.tryPromise(() => txn.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.tryPromise(() => txn.deleteAlarm(options)),
});

export const fromDurableObjectStorage = (
  storage: cf.DurableObjectStorage,
): DurableObjectStorage => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.tryPromise(() => storage.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.tryPromise(() => storage.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.tryPromise(() =>
          storage.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.tryPromise(() =>
          storage.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) =>
    Effect.tryPromise(() => storage.delete(keyOrKeys as any, options))) as any,
  deleteAll: (options?: cf.DurableObjectPutOptions) =>
    Effect.tryPromise(() => storage.deleteAll(options)),
  transaction: <T>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T>,
  ) =>
    Effect.tryPromise(() =>
      storage.transaction((txn) =>
        Effect.runPromise(closure(fromDurableObjectTransaction(txn))),
      ),
    ),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.tryPromise(() => storage.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.tryPromise(() => storage.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.tryPromise(() => storage.deleteAlarm(options)),
  sync: () => Effect.tryPromise(() => storage.sync()),
  sql: fromSqlStorage(storage.sql),
  kv: storage.kv,
  transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
  getCurrentBookmark: () =>
    Effect.tryPromise(() => storage.getCurrentBookmark()),
  getBookmarkForTime: (timestamp: number | Date) =>
    Effect.tryPromise(() => storage.getBookmarkForTime(timestamp)),
  onNextSessionRestoreBookmark: (bookmark: string) =>
    Effect.tryPromise(() => storage.onNextSessionRestoreBookmark(bookmark)),
});
