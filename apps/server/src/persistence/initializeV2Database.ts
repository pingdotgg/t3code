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

const isV2DatabaseImportError = Schema.is(V2DatabaseImportError);

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

// Legacy names have no PID; newer copies stay while their process is alive.
const removeAbandonedCopies = Effect.fn("removeAbandonedCopies")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  for (const entry of entries) {
    const copy = /^\.v2-import-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(entry);
    if (copy === null || (copy[1] !== undefined && isProcessAlive(Number(copy[1])))) continue;
    yield* fs.remove(path.join(directory, entry), { recursive: true });
  }
});

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

// Copies through SQLite instead of renaming files, so connections that CLI commands hold without
// server ownership keep writing to the live database. The copy holds the V2 write lock from its
// first step until it commits; rate 1 makes that first step return early (any V1 database spans
// more than one page), so the inspection and backup run where no CLI write can slip in.
async function recopyIfStale(sourcePath: string, destinationPath: string, backupPath: string) {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  let inspected = false;
  let kept: "current" | "diverged" | undefined;
  try {
    await NodeSqlite.backup(source, destinationPath, {
      rate: 1,
      progress: () => {
        if (inspected) return;
        inspected = true;
        const state = inspectStaleCopy(sourcePath, destinationPath);
        if (state !== "stale") {
          kept = state;
          throw new Error("The V2 database is no longer stale");
        }
        const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
        try {
          copy.prepare("VACUUM INTO ?").run(backupPath);
        } finally {
          copy.close();
        }
      },
    });
  } catch (error) {
    if (kept !== undefined) return kept;
    throw error;
  } finally {
    source.close();
  }
  return "stale" as const;
}

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* removeAbandonedCopies(directory).pipe(Effect.ignore({ log: true }));
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: `.v2-import-${process.pid}-`,
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise({
      try: async () => {
        const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
        try {
          await NodeSqlite.backup(database, snapshotPath);
        } finally {
          database.close();
        }
      },
      catch: (cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs.link(snapshotPath, destinationPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        (_error) => Effect.void,
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      isV2DatabaseImportError(cause)
        ? cause
        : new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    ),
  );
});

/**
 * Replaces a V2 copy nobody worked in when V1 changed after it was taken, as after a preview or a
 * rollback while the user kept using V1. Only the server calls this, under its ownership lock, so
 * two processes never replace the copy at once.
 */
export const replaceStaleV2Database = Effect.fn("replaceStaleV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(path.dirname(destinationPath), "state.sqlite");
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(sourcePath)) || !(yield* fs.exists(destinationPath))) return;
    const checked = yield* Effect.try({
      try: () => inspectStaleCopy(sourcePath, destinationPath),
      catch: (cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    }).pipe(Effect.orElseSucceed(() => "current" as const));
    if (checked === "current") return;
    const backupPath = `${destinationPath}.stale`;
    const state =
      checked === "diverged"
        ? checked
        : yield* Effect.gen(function* () {
            // A previous backup was also a copy without V2 work, so one backup is enough.
            for (const suffix of ["", "-wal", "-shm"]) {
              yield* fs.remove(backupPath + suffix, { force: true });
            }
            return yield* Effect.tryPromise({
              try: () => recopyIfStale(sourcePath, destinationPath, backupPath),
              catch: (cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
            });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "The V2 database predates newer V1 data, but it could not be copied again; keeping it",
                { destinationPath, cause },
              ).pipe(Effect.as("current" as const)),
            ),
          );
    if (state === "diverged") {
      yield* Effect.logWarning(
        "The V1 database has newer projects or threads, but they are not imported because the V2 database already holds V2 work",
        { sourcePath, destinationPath },
      );
    } else if (state === "stale") {
      yield* Effect.logWarning(
        "The V2 database predates newer V1 data and holds no V2 work; backed it up and copied V1 again",
        { backupPath },
      );
    }
  }).pipe(
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
  yield* initializeV2Database(destinationPath);
});
