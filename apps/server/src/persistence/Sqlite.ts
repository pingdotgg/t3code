import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { hasPendingMigrations, runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import * as ServerOwnership from "../serverOwnership.ts";

const WAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

export class ServerOwnsDatabaseError extends Schema.TaggedError<ServerOwnsDatabaseError>()(
  "ServerOwnsDatabaseError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `Another T3 Code process, usually a running server, owns ${this.stateDir}, and this CLI would change its database schema. Use the \`t3\` that matches the running server, or stop that server, then retry. The database was not changed.`;
  }
}

// SQLITE_CORRUPT and SQLITE_NOTADB; node:sqlite reports extended codes whose low byte is the primary code.
const DAMAGED_SQLITE_CODES = new Set([11, 26]);

const isDamagedDatabase = (error: SqlError.SqlError): boolean => {
  const seen = new Set<unknown>();
  let cause: unknown = error.cause;
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    if (typeof cause.errcode === "number" && DAMAGED_SQLITE_CODES.has(cause.errcode & 0xff)) {
      return true;
    }
    cause = cause.cause;
  }
  return false;
};

// Keeps the SqlError type so callers' error channels do not change; the original stays as the cause.
const damagedDatabaseError = (dbPath: string, cause: SqlError.SqlError) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause,
      operation: "open",
      message: `The T3 Code database at ${dbPath} is damaged or is not a SQLite database, so T3 Code cannot start. To recover, quit T3 Code, then move that file and any -wal and -shm files next to it out of the folder, or replace them with a backup. T3 Code creates a new database on the next start.`,
    }),
  });

// CLI commands open the server's database from another process; migrating behind its owner changes the schema it runs on.
const runMigrationsAsOwner = Effect.fn("SqlitePersistence.runMigrationsAsOwner")(function* () {
  // With nothing pending, runMigrations only validates the recorded history and writes nothing.
  if (!(yield* hasPendingMigrations())) return yield* runMigrations();
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  yield* ServerOwnership.holdServerOwnershipLock(serverRuntimeStatePath).pipe(
    Effect.catchTags({
      ServerAlreadyRunningError: ({ stateDir }) =>
        Effect.fail(new ServerOwnsDatabaseError({ stateDir })),
    }),
  );
  yield* runMigrations();
}, Effect.scoped);

// Index builds over large tables take minutes; on the main connection they block the event loop,
// so requests hang instead of getting the listener's 503. A fresh database stays on the main
// connection, which must create the first table for its auto_vacuum setting to apply.
const runMigrationsOffMainThread = Effect.fn("SqlitePersistence.runMigrationsOffMainThread")(
  function* (dbPath: string) {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if (!tables[0]?.count || !(yield* hasPendingMigrations())) return yield* runMigrations();
    return yield* Effect.gen(function* () {
      const worker = yield* SqlClient.SqlClient;
      yield* worker`PRAGMA foreign_keys = ON;`;
      yield* worker`PRAGMA synchronous = NORMAL;`;
      yield* worker`PRAGMA temp_store = MEMORY;`;
      return yield* runMigrations();
    }).pipe(Effect.provide(NodeSqliteClient.layerWorker(dbPath)));
  },
);

const makeLayerSetup = <E, R>(migrate: Effect.Effect<unknown, E, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
      const tables = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
      if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints.
      // App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption.
      yield* sql`PRAGMA synchronous = NORMAL;`;
      // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
      yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
      // Keep statement journals and sort spills off the main thread's disk path.
      // Large statements and open savepoints can increase peak memory use.
      yield* sql`PRAGMA temp_store = MEMORY;`;
      // PASSIVE checkpoints retain peak WAL size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      yield* migrate;
      // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
      // Connections cache stats; reload after deleting them.
      const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
      if (statTables.length > 0) {
        yield* sql`DELETE FROM sqlite_stat1;`;
        yield* sql`ANALYZE sqlite_schema;`;
      }
    }).pipe(Effect.withSpan("Sqlite.setup")),
  );

const layerSetup = makeLayerSetup(runMigrations());

const makeLayerFromPath = <E, R>(makeSetup: (dbPath: string) => Layer.Layer<never, E, R>) =>
  Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(
      makeSetup(dbPath),
      NodeSqliteClient.layer({
        filename: dbPath,
        readerWorker: true,
        // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
        checkpointWorker: true,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3code-server",
        },
      }),
    ).pipe(
      Layer.catchTag("SqlError", (error) =>
        Layer.effect(
          SqlClient.SqlClient,
          Effect.fail(
            SqlError.isSqlError(error) && isDamagedDatabase(error)
              ? damagedDatabaseError(dbPath, error)
              : error,
          ),
        ),
      ),
    );
  }, Layer.unwrap);

export const layerFromPath = makeLayerFromPath((dbPath) =>
  makeLayerSetup(runMigrationsOffMainThread(dbPath)),
);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

const makeLayerConfig = <E, R>(
  fromPath: (dbPath: string) => Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { dbPath } = yield* ServerConfig.ServerConfig;
      yield* initializeV2Database(dbPath);
      return fromPath(dbPath);
    }),
  );

export const layerConfig = makeLayerConfig(layerFromPath);

/** For CLI commands: pending migrations run only while no server owns the T3 home. */
export const layerCliConfig = makeLayerConfig(
  makeLayerFromPath(() => makeLayerSetup(runMigrationsAsOwner())),
);
