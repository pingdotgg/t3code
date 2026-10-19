import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export class DatabaseMissingError extends Schema.TaggedError<DatabaseMissingError>()(
  "DatabaseMissingError",
  { path: Schema.String },
) {
  override get message() {
    return "No existing T3 Code database was found in this data directory.";
  }
}

export class DatabaseInUseError extends Schema.TaggedError<DatabaseInUseError>()(
  "DatabaseInUseError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Stop the T3 Code server and desktop app, including any version before 0.1.0, before repairing the database.";
  }
}

export class DatabaseProjectionsInvalidError extends Schema.TaggedError<DatabaseProjectionsInvalidError>()(
  "DatabaseProjectionsInvalidError",
  { path: Schema.String },
) {
  override get message() {
    return "Database projections need repair before compaction. Start T3 Code once so it rebuilds them, then run doctor again. If this CLI is older than the one that wrote the database, update T3 Code first.";
  }
}

export class DatabaseInspectError extends Schema.TaggedError<DatabaseInspectError>()(
  "DatabaseInspectError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not read the database. Check that this user can open it.";
  }
}

export class DatabaseCompactError extends Schema.TaggedError<DatabaseCompactError>()(
  "DatabaseCompactError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Database compaction failed. Check that no other process has the database open and enough disk space is available.";
  }
}

export class LegacyDatabaseRemoveError extends Schema.TaggedError<LegacyDatabaseRemoveError>()(
  "LegacyDatabaseRemoveError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not delete the database from before 0.1.0. Check that this user can write to the data directory.";
  }
}

/** Offline inspection and repair of a T3 state database, for `t3 doctor`. */
export class DatabaseMaintenance extends Context.Service<
  DatabaseMaintenance,
  {
    readonly inspect: (databasePath: string) => Effect.Effect<
      {
        readonly databaseBytes: number;
        readonly reclaimableBytes: number;
        readonly incrementalVacuumEnabled: boolean;
        /** Size of the database from before 0.1.0 still kept beside it, or null. */
        readonly legacyDatabaseBytes: number | null;
      },
      DatabaseMissingError | DatabaseInspectError
    >;
    /** Compacts history, then VACUUMs into incremental auto_vacuum. Refuses while a server has it open. */
    readonly compact: (databasePath: string) => Effect.Effect<
      {
        readonly beforeBytes: number;
        readonly afterBytes: number;
        readonly deletedEventCount: number;
        readonly deletedReceiptCount: number;
      },
      | DatabaseMissingError
      | DatabaseInUseError
      | DatabaseProjectionsInvalidError
      | DatabaseCompactError
    >;
    /**
     * Deletes the database from before 0.1.0 kept beside this one. Versions
     * before 0.1.0 read only that file; this one stays intact.
     */
    readonly removeLegacyDatabase: (
      databasePath: string,
    ) => Effect.Effect<void, DatabaseInUseError | LegacyDatabaseRemoveError>;
  }
>()("t3/persistence/DatabaseMaintenance") {}

const isDomainError = Schema.is(
  Schema.Union([DatabaseMissingError, DatabaseInUseError, DatabaseProjectionsInvalidError]),
);

const readStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  const pageSize = size[0]?.page_size ?? 0;
  return {
    databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
    reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
    incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
  };
});

/**
 * Holds an exclusive lock on the connection's database. In WAL mode this is
 * refused while any other connection has the file open, even an idle one,
 * which is how a running server or desktop app is detected.
 */
const lockExclusively = (databasePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 0`;
    yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
    yield* sql`BEGIN EXCLUSIVE`.pipe(
      Effect.mapError((cause) =>
        isSqlError(cause) && cause.reason._tag === "LockTimeoutError"
          ? new DatabaseInUseError({ path: databasePath, cause })
          : cause,
      ),
    );
    yield* sql`COMMIT`;
  });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyPath = (databasePath: string) =>
    path.join(path.dirname(databasePath), "state.sqlite");

  const locate = Effect.fn("DatabaseMaintenance.locate")(function* (databasePath: string) {
    if (!(yield* fs.exists(databasePath))) {
      return yield* new DatabaseMissingError({ path: databasePath });
    }
  });

  const inspect = Effect.fn("DatabaseMaintenance.inspect")(
    function* (databasePath: string) {
      yield* locate(databasePath);
      const storage = yield* readStorage.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
      );
      const legacy = legacyPath(databasePath);
      const legacyDatabaseBytes = (yield* fs.exists(legacy))
        ? Number((yield* fs.stat(legacy)).size)
        : null;
      return { ...storage, legacyDatabaseBytes };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ? cause : new DatabaseInspectError({ path: databasePath, cause }),
        ),
      ),
  );

  const compact = Effect.fn("DatabaseMaintenance.compact")(
    function* (databasePath: string) {
      yield* locate(databasePath);
      const beforeBytes = Number((yield* fs.stat(databasePath)).size);
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Held through compaction and VACUUM.
        yield* lockExclusively(databasePath);
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        if (!(yield* maintenance.verify).valid) {
          return yield* new DatabaseProjectionsInvalidError({ path: databasePath });
        }
        const summary = yield* maintenance.compactEventStore;
        if (!(yield* maintenance.verify).valid) {
          return yield* new DatabaseProjectionsInvalidError({ path: databasePath });
        }
        // VACUUM rebuilds the file, which is the only way to switch an existing
        // database to incremental auto_vacuum; the server reclaims online after.
        yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`VACUUM`;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        return summary;
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
            Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
          ),
        ),
      );
      const afterBytes = Number((yield* fs.stat(databasePath)).size);
      return {
        beforeBytes,
        afterBytes,
        deletedEventCount: result.deletedEventCount,
        deletedReceiptCount: result.deletedReceiptCount,
      };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ? cause : new DatabaseCompactError({ path: databasePath, cause }),
        ),
      ),
  );

  const removeLegacyDatabase = Effect.fn("DatabaseMaintenance.removeLegacyDatabase")(
    function* (databasePath: string) {
      const legacy = legacyPath(databasePath);
      if (!(yield* fs.exists(legacy))) return;
      // A version before 0.1.0 may still be running against it. Keep the lock
      // while deleting, and delete the database before its WAL so a failure
      // never leaves it without committed transactions.
      yield* Effect.gen(function* () {
        yield* lockExclusively(legacy);
        for (const suffix of ["", "-wal", "-shm"]) {
          yield* fs.remove(legacy + suffix, { force: true });
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: legacy })));
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "DatabaseInUseError"
            ? cause
            : new LegacyDatabaseRemoveError({ path: legacyPath(databasePath), cause }),
        ),
      ),
  );

  return DatabaseMaintenance.of({ inspect, compact, removeLegacyDatabase });
});

export const layer = Layer.effect(DatabaseMaintenance, make);
