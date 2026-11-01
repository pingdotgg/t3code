import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SQLiteDatabase } from "expo-sqlite";

const DATABASE_NAME = "t3code-client.db";
const DATABASE_SCHEMA_VERSION = 1;

export const ClientCacheKind = Schema.Literals([
  "shell",
  "thread",
  "server-config",
  "vcs-refs",
  "project-favicon",
  "pull-request",
]);
export type ClientCacheKind = typeof ClientCacheKind.Type;

export interface ClientCacheSummaryRow {
  readonly environmentId: EnvironmentId;
  readonly kind: ClientCacheKind;
  readonly recordCount: number;
  readonly payloadBytes: number;
}

export interface StoredPreferencesJson {
  readonly payload: string;
  readonly updatedAt: number;
}

const ClientCacheSummaryRows = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    kind: ClientCacheKind,
    recordCount: Schema.Number,
    payloadBytes: Schema.Number,
  }),
);

const MobileDatabaseOperation = Schema.Literals([
  "open",
  "migrate",
  "load-cache",
  "list-cache",
  "save-cache",
  "remove-cache",
  "clear-cache-kind",
  "clear-environment-cache",
  "clear-all-caches",
  "inspect-caches",
  "load-preferences",
  "save-preferences",
]);

export class MobileDatabaseError extends Schema.TaggedError<MobileDatabaseError>()(
  "MobileDatabaseError",
  {
    operation: MobileDatabaseOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile database operation failed: ${this.operation}.`;
  }
}

function databaseError(operation: typeof MobileDatabaseOperation.Type) {
  return (cause: unknown) => new MobileDatabaseError({ operation, cause });
}

export class MobileDatabase extends Context.Service<
  MobileDatabase,
  {
    readonly loadCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<Option.Option<string>, MobileDatabaseError>;
    readonly listCache: (
      kind: ClientCacheKind,
    ) => Effect.Effect<ReadonlyArray<string>, MobileDatabaseError>;
    readonly saveCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
      schemaVersion: number,
      payload: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly removeCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearCacheKind: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearEnvironmentCache: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearAllCaches: Effect.Effect<void, MobileDatabaseError>;
    readonly inspectCaches: Effect.Effect<
      ReadonlyArray<ClientCacheSummaryRow>,
      MobileDatabaseError
    >;
    readonly loadPreferencesJson: Effect.Effect<
      Option.Option<StoredPreferencesJson>,
      MobileDatabaseError
    >;
    readonly savePreferencesJson: (
      payload: string,
      updatedAt: number,
    ) => Effect.Effect<void, MobileDatabaseError>;
  }
>()("@t3tools/mobile/persistence/MobileDatabase") {}

const makeAvailable = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const SQLite = await import("expo-sqlite");
        return SQLite.openDatabaseAsync(DATABASE_NAME);
      },
      catch: databaseError("open"),
    }),
    (openDatabase) => Effect.promise(() => openDatabase.closeAsync()).pipe(Effect.ignore),
  );

  yield* Effect.tryPromise({
    try: async () => {
      await database.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      const schema = await database.getFirstAsync<{ readonly user_version: number }>(
        "PRAGMA user_version",
      );
      await database.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.execAsync(`
              CREATE TABLE IF NOT EXISTS client_cache (
                environment_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (environment_id, kind, cache_key)
              ) WITHOUT ROWID;

              CREATE INDEX IF NOT EXISTS client_cache_environment_updated
                ON client_cache (environment_id, updated_at DESC);

              CREATE TABLE IF NOT EXISTS client_preferences (
                singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
              );
            `);
      });
      if ((schema?.user_version ?? 0) < DATABASE_SCHEMA_VERSION) {
        await database.execAsync(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
      }
    },
    catch: databaseError("migrate"),
  });

  return MobileDatabase.of({
    loadCache: Effect.fn("MobileDatabase.loadCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.getFirstAsync<{ readonly payload: string }>(
            `SELECT payload
                     FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?
                       AND (kind != 'pull-request' OR updated_at >= ?)`,
            environmentId,
            kind,
            cacheKey,
            Date.now() - 30 * 24 * 60 * 60_000,
          ),
        catch: databaseError("load-cache"),
      }).pipe(Effect.map((row) => Option.fromNullishOr(row?.payload))),
    ),
    listCache: Effect.fn("MobileDatabase.listCache")((kind) =>
      Effect.tryPromise({
        try: () =>
          database.getAllAsync<{ readonly payload: string }>(
            "SELECT payload FROM client_cache WHERE kind = ? ORDER BY updated_at",
            kind,
          ),
        catch: databaseError("list-cache"),
      }).pipe(Effect.map((rows) => rows.map((row) => row.payload))),
    ),
    saveCache: Effect.fn("MobileDatabase.saveCache")(
      (environmentId, kind, cacheKey, schemaVersion, payload) =>
        Effect.tryPromise({
          try: async () => {
            // Bound offline PR caches to 32 MiB and 256 responses per environment; reject huge diffs that would evict everything.
            if (
              kind === "pull-request" &&
              new TextEncoder().encode(payload).length > 4 * 1024 * 1024
            )
              return;
            const save = async (transaction: SQLiteDatabase) => {
              await transaction.runAsync(
                `INSERT INTO client_cache
                  (environment_id, kind, cache_key, schema_version, payload, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
                   schema_version = excluded.schema_version,
                   payload = excluded.payload,
                   updated_at = excluded.updated_at`,
                environmentId,
                kind,
                cacheKey,
                schemaVersion,
                payload,
                Date.now(),
              );
              if (kind === "pull-request") {
                await transaction.runAsync(
                  `DELETE FROM client_cache WHERE environment_id = ? AND kind = 'pull-request'
                   AND cache_key IN (
                     SELECT cache_key FROM (
                       SELECT cache_key, updated_at,
                         ROW_NUMBER() OVER (ORDER BY updated_at DESC, cache_key) AS position,
                         SUM(LENGTH(CAST(payload AS BLOB))) OVER (
                           ORDER BY updated_at DESC, cache_key
                         ) AS total_bytes
                       FROM client_cache WHERE environment_id = ? AND kind = 'pull-request'
                     ) WHERE position > 256 OR total_bytes > 33554432 OR updated_at < ?
                   )`,
                  environmentId,
                  environmentId,
                  Date.now() - 30 * 24 * 60 * 60_000,
                );
              }
            };
            await save(database);
          },
          catch: databaseError("save-cache"),
        }).pipe(Effect.asVoid),
    ),
    removeCache: Effect.fn("MobileDatabase.removeCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `DELETE FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError("remove-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearCacheKind: Effect.fn("MobileDatabase.clearCacheKind")((environmentId, kind) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            "DELETE FROM client_cache WHERE environment_id = ? AND kind = ?",
            environmentId,
            kind,
          ),
        catch: databaseError("clear-cache-kind"),
      }).pipe(Effect.asVoid),
    ),
    clearEnvironmentCache: Effect.fn("MobileDatabase.clearEnvironmentCache")((environmentId) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync("DELETE FROM client_cache WHERE environment_id = ?", environmentId),
        catch: databaseError("clear-environment-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearAllCaches: Effect.tryPromise({
      try: () => database.runAsync("DELETE FROM client_cache"),
      catch: databaseError("clear-all-caches"),
    }).pipe(Effect.asVoid),
    inspectCaches: Effect.tryPromise({
      try: () =>
        database.getAllAsync<unknown>(`
                SELECT
                  environment_id AS environmentId,
                  kind,
                  COUNT(*) AS recordCount,
                  COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS payloadBytes
                FROM client_cache
                GROUP BY environment_id, kind
                ORDER BY environment_id, kind
              `),
      catch: databaseError("inspect-caches"),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClientCacheSummaryRows)),
      Effect.mapError(databaseError("inspect-caches")),
      Effect.map((rows): ReadonlyArray<ClientCacheSummaryRow> =>
        rows.map((row) => ({
          environmentId: row.environmentId as EnvironmentId,
          kind: row.kind,
          recordCount: row.recordCount,
          payloadBytes: row.payloadBytes,
        })),
      ),
    ),
    loadPreferencesJson: Effect.tryPromise({
      try: () =>
        database.getFirstAsync<StoredPreferencesJson>(
          `SELECT payload, updated_at AS updatedAt
                 FROM client_preferences
                 WHERE singleton = 1`,
        ),
      catch: databaseError("load-preferences"),
    }).pipe(Effect.map(Option.fromNullishOr)),
    savePreferencesJson: Effect.fn("MobileDatabase.savePreferencesJson")((payload, updatedAt) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `INSERT INTO client_preferences (singleton, payload, updated_at)
                   VALUES (1, ?, ?)
                   ON CONFLICT (singleton) DO UPDATE SET
                     payload = excluded.payload,
                     updated_at = excluded.updated_at`,
            payload,
            updatedAt,
          ),
        catch: databaseError("save-preferences"),
      }).pipe(Effect.asVoid),
    ),
  });
});

function makeUnavailable(error: MobileDatabaseError): MobileDatabase["Service"] {
  const fail = Effect.fail(error);
  return MobileDatabase.of({
    loadCache: () => fail,
    listCache: () => fail,
    saveCache: () => fail,
    removeCache: () => fail,
    clearCacheKind: () => fail,
    clearEnvironmentCache: () => fail,
    clearAllCaches: fail,
    inspectCaches: fail,
    loadPreferencesJson: fail,
    savePreferencesJson: () => fail,
  });
}

export const make = Effect.result(makeAvailable).pipe(
  Effect.map((result) =>
    result._tag === "Success" ? result.success : makeUnavailable(result.failure),
  ),
);

export const layer = Layer.effect(MobileDatabase, make);
