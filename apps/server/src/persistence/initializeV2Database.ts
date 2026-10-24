import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

const LEGACY_SHELL_TABLES = [
  { table: "projection_projects", id: "project_id" },
  { table: "projection_threads", id: "thread_id" },
] as const;

// Compares shells rather than event sequences: compaction deletes copied V1 events from V2.
function hasNewerV1Shells(source: NodeSqlite.DatabaseSync, copy: NodeSqlite.DatabaseSync) {
  return LEGACY_SHELL_TABLES.some(({ table, id }) => {
    const query = `SELECT ${id} AS id, updated_at FROM ${table}`;
    const copied = new Map(
      copy
        .prepare(query)
        .all()
        .map((row) => [row.id, row.updated_at]),
    );
    return source
      .prepare(query)
      .all()
      .some((row) => {
        const copiedUpdatedAt = copied.get(row.id);
        return copiedUpdatedAt === undefined || String(row.updated_at) > String(copiedUpdatedAt);
      });
  });
}

function hasTable(database: NodeSqlite.DatabaseSync, table: string) {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function tableIds(database: NodeSqlite.DatabaseSync, table: string, column: string) {
  if (!hasTable(database, table)) return new Set<unknown>();
  return new Set(
    database
      .prepare(`SELECT ${column} AS id FROM ${table}`)
      .all()
      .map((row) => row.id),
  );
}

function hasIdsBeyond(
  copy: NodeSqlite.DatabaseSync,
  source: NodeSqlite.DatabaseSync,
  table: string,
  column: string,
) {
  const sourceIds = tableIds(source, table, column);
  return [...tableIds(copy, table, column)].some((id) => !sourceIds.has(id));
}

// Judged by content, not events: the server writes its own events (auto-settle, PR sync) within
// a minute of starting, and scheduled tasks are stored without events. Imported threads and
// messages keep their V1 ids, so rows beyond the copied legacy tables were created in V2.
function hasV2Work(source: NodeSqlite.DatabaseSync, copy: NodeSqlite.DatabaseSync) {
  const hasRow = (query: string) => copy.prepare(query).get() !== undefined;
  return (
    (hasTable(copy, "orchestration_v2_projection_threads") &&
      (hasRow(
        "SELECT 1 FROM orchestration_v2_projection_threads AS v2 WHERE NOT EXISTS (SELECT 1 FROM projection_threads AS v1 WHERE v1.thread_id = v2.thread_id) LIMIT 1",
      ) ||
        hasRow(
          "SELECT 1 FROM orchestration_v2_projection_messages AS v2 WHERE NOT EXISTS (SELECT 1 FROM projection_thread_messages AS v1 WHERE v1.message_id = v2.message_id) LIMIT 1",
        ))) ||
    hasIdsBeyond(copy, source, "projection_projects", "project_id") ||
    hasIdsBeyond(copy, source, "scheduled_tasks", "task_id") ||
    hasV2Revocations(source, copy)
  );
}

const CLOSABLE_AUTH_TABLES = [
  { table: "auth_sessions", id: "session_id", closed: "revoked_at IS NOT NULL" },
  {
    table: "auth_pairing_links",
    id: "id",
    closed: "revoked_at IS NOT NULL OR consumed_at IS NOT NULL",
  },
] as const;

// A re-copy would restore V1's open row, letting a device revoked in V2 connect again.
function hasV2Revocations(source: NodeSqlite.DatabaseSync, copy: NodeSqlite.DatabaseSync) {
  return CLOSABLE_AUTH_TABLES.some(({ table, id, closed }) => {
    if (!hasTable(source, table) || !hasTable(copy, table)) return false;
    const openInV1 = new Set(
      source
        .prepare(`SELECT ${id} AS id FROM ${table} WHERE NOT (${closed})`)
        .all()
        .map((row) => row.id),
    );
    return copy
      .prepare(`SELECT ${id} AS id FROM ${table} WHERE ${closed}`)
      .all()
      .some((row) => openInV1.has(row.id));
  });
}

// Leaves the main file complete, so moving it alone moves the whole database.
function checkpointCopy(destinationPath: string) {
  const copy = new NodeSqlite.DatabaseSync(destinationPath);
  try {
    const result = copy.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0) throw new Error("The V2 database is in use by another process");
  } finally {
    copy.close();
  }
}

function inspectStaleCopy(sourcePath: string, destinationPath: string) {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
    try {
      if (!hasNewerV1Shells(source, copy)) return "current" as const;
      return hasV2Work(source, copy) ? ("diverged" as const) : ("stale" as const);
    } finally {
      copy.close();
    }
  } finally {
    source.close();
  }
}

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});

/**
 * Replaces a V2 copy nobody worked in when V1 changed after it was taken, as after a preview or a
 * rollback while the user kept using V1. Moving the database aside is only safe while holding
 * server ownership, so CLI processes that open persistence never call this.
 */
export const replaceStaleV2Database = Effect.fn("replaceStaleV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(path.dirname(destinationPath), "state.sqlite");
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(sourcePath)) || !(yield* fs.exists(destinationPath))) return;
    const state = yield* Effect.try(() => inspectStaleCopy(sourcePath, destinationPath)).pipe(
      Effect.orElseSucceed(() => "current" as const),
    );
    if (state === "current") return;
    if (state === "diverged") {
      yield* Effect.logWarning(
        "The V1 database has newer projects or threads, but they are not imported because the V2 database already holds V2 work",
        { sourcePath, destinationPath },
      );
      return;
    }
    const backupPath = `${destinationPath}.stale`;
    const moved = yield* Effect.gen(function* () {
      yield* Effect.try(() => checkpointCopy(destinationPath));
      // A previous backup was also a copy without V2 work, so one backup is enough.
      for (const suffix of ["", "-wal", "-shm"]) {
        yield* fs.remove(backupPath + suffix, { force: true });
      }
      // The main file goes first: after the checkpoint it holds everything, so a failed rename
      // moves nothing.
      yield* fs.rename(destinationPath, backupPath);
    }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning(
          "The V2 database predates newer V1 data, but it could not be moved aside; keeping it",
          { destinationPath, cause },
        ).pipe(Effect.as(false)),
      ),
    );
    if (!moved) return;
    // Checkpointed sidecars are empty, so one left behind cannot corrupt the fresh copy.
    for (const suffix of ["-wal", "-shm"]) {
      yield* fs.rename(destinationPath + suffix, backupPath + suffix).pipe(Effect.ignore);
    }
    yield* Effect.logWarning(
      "The V2 database predates newer V1 data and holds no V2 work; moved it aside and copied V1 again",
      { backupPath },
    );
  }).pipe(
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
  yield* initializeV2Database(destinationPath);
});
