import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { SERVER_EXIT_CODE_DATABASE_REFUSED } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { hasPendingMigrations, runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import * as ServerOwnership from "../serverOwnership.ts";

const WAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

// Read-only connections, each a worker thread of about 15-20 MB RSS under load.
// Background scans (shell snapshots, pull request sync, settlement sweeps,
// storage cleanup) share all but one, so with four, three scans run at once
// and short reads always have a free reader. 0 sends every read to the writer.
const DEFAULT_READERS = 4;
const readersConfig = Config.Int("T3CODE_SQLITE_READERS").pipe(
  Config.map((readers) => Math.max(0, readers)),
);

/**
 * The migrations refused this database's history before changing it. Its own
 * exit code tells a supervisor that restarting would only be refused again.
 */
export class DatabaseRefusedError extends Schema.TaggedError<DatabaseRefusedError>()(
  "DatabaseRefusedError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_DATABASE_REFUSED;

  override get message(): string {
    return `T3 Code did not open its database, and left it unchanged: ${this.detail}`;
  }
}

export class ServerOwnsDatabaseError extends Schema.TaggedError<ServerOwnsDatabaseError>()(
  "ServerOwnsDatabaseError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `Another T3 Code process, usually a running server, owns ${this.stateDir}, and this CLI would change its database schema. Use the \`t3\` that matches the running server, or stop that server, then retry. The database was not changed.`;
  }
}

// A history the migrations refuse is left unchanged, and exits with a code supervisors do not restart.
const migrateOrRefuse = runMigrations().pipe(
  Effect.catchTags({
    MigrationError: (error) =>
      Effect.fail(
        error.kind === "BadState" ? new DatabaseRefusedError({ detail: error.message }) : error,
      ),
  }),
);

// CLI commands open the server's database from another process; migrating behind its owner changes the schema it runs on.
const runMigrationsAsOwner = Effect.fn("SqlitePersistence.runMigrationsAsOwner")(function* () {
  // With nothing pending, runMigrations only validates the recorded history and writes nothing.
  if (!(yield* hasPendingMigrations())) return yield* migrateOrRefuse;
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  yield* ServerOwnership.holdServerOwnershipLock(serverRuntimeStatePath).pipe(
    Effect.catchTags({
      ServerAlreadyRunningError: ({ stateDir }) =>
        Effect.fail(new ServerOwnsDatabaseError({ stateDir })),
    }),
  );
  yield* migrateOrRefuse;
}, Effect.scoped);

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

const layerSetup = makeLayerSetup(migrateOrRefuse);

const makeLayerFromPath = <E, R>(setup: Layer.Layer<never, E, R>) =>
  Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
    const readers = yield* readersConfig.pipe(Effect.orElseSucceed(() => DEFAULT_READERS));

    return Layer.provideMerge(
      setup,
      NodeSqliteClient.layer({
        filename: dbPath,
        readers,
        // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
        checkpointWorker: true,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3code-server",
        },
      }),
    );
  }, Layer.unwrap);

export const layerFromPath = makeLayerFromPath(layerSetup);

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
  makeLayerFromPath(makeLayerSetup(runMigrationsAsOwner())),
);
