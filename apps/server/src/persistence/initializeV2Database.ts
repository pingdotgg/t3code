import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

const hasTable = (database: NodeSqlite.DatabaseSync, name: string) =>
  database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

const readLastEventId = (database: NodeSqlite.DatabaseSync) => {
  if (!hasTable(database, "orchestration_events")) return null;
  const row = database
    .prepare("SELECT event_id FROM orchestration_events ORDER BY sequence DESC LIMIT 1")
    .get();
  return typeof row?.event_id === "string" ? row.event_id : null;
};

// The table exists until a server commits to the copy. A launcher that rolls a
// trial back restores only state.sqlite, so V1 can keep changing after the copy.
const markUncommitted = (snapshotPath: string) => {
  const snapshot = new NodeSqlite.DatabaseSync(snapshotPath);
  try {
    snapshot.exec("CREATE TABLE uncommitted_v1_copy (last_event_id TEXT)");
    snapshot
      .prepare("INSERT INTO uncommitted_v1_copy (last_event_id) VALUES (?)")
      .run(readLastEventId(snapshot));
  } finally {
    snapshot.close();
  }
};

const isBehindV1 = (copyPath: string, sourcePath: string) => {
  const copy = new NodeSqlite.DatabaseSync(copyPath, { readOnly: true });
  try {
    if (!hasTable(copy, "uncommitted_v1_copy")) return false;
    const copied = copy.prepare("SELECT last_event_id FROM uncommitted_v1_copy").get();
    const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      return readLastEventId(source) !== (copied?.last_event_id ?? null);
    } finally {
      source.close();
    }
  } finally {
    copy.close();
  }
};

// In WAL mode an exclusive lock is refused while another connection has the
// database open, so a copy that another process still uses is never replaced.
const isUnusedUncommittedCopy = (copyPath: string) => {
  const copy = new NodeSqlite.DatabaseSync(copyPath);
  try {
    copy.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    const uncommitted = hasTable(copy, "uncommitted_v1_copy");
    copy.exec("COMMIT");
    return uncommitted;
  } catch (cause) {
    // node:sqlite reports extended codes such as SQLITE_BUSY_RECOVERY (261); the low byte is SQLITE_BUSY.
    if (
      cause instanceof Error &&
      "errcode" in cause &&
      typeof cause.errcode === "number" &&
      (cause.errcode & 0xff) === 5
    )
      return false;
    throw cause;
  } finally {
    copy.close();
  }
};

const copyDatabase = (sourcePath: string, destinationPath: string) =>
  Effect.tryPromise(async () => {
    const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      await NodeSqlite.backup(source, destinationPath);
    } finally {
      source.close();
    }
  });

/**
 * Its copied legacy tables remain the source for lazy transcript import.
 *
 * With `deferCommit`, the caller is a server that runs `commitV1Copy` once no
 * launcher can roll it back. Until then only its own startup has written to the
 * copy, so a later start that finds newer V1 events copies V1 again instead of
 * hiding them.
 */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
  options?: { readonly deferCommit?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  const deferCommit = options?.deferCommit === true;
  const behindV1 = Effect.try(() => isBehindV1(destinationPath, sourcePath)).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not compare the uncommitted V2 database with V1", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const copied = yield* fs.exists(destinationPath);
    if (copied && !deferCommit) return;
    if (!(yield* fs.exists(sourcePath))) return;
    if (copied && !(yield* behindV1)) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* copyDatabase(sourcePath, snapshotPath);
    if (deferCommit) yield* Effect.try(() => markUncommitted(snapshotPath));
    if (copied) {
      if (!(yield* Effect.try(() => isUnusedUncommittedCopy(destinationPath)))) {
        return yield* Effect.logWarning(
          "V1 changed after the uncommitted V2 database was copied, but another process has it open, so it is kept",
        );
      }
      // The backup replaces the copy in one transaction: readers see the old copy or the new one.
      yield* copyDatabase(snapshotPath, destinationPath);
      return yield* Effect.logInfo(
        "Copied V1 again: it changed after a start that never committed to its V2 database",
      );
    }
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
 * Makes the copy final. A server runs it once no launcher can roll it back and
 * before it accepts commands. Any other process runs it on open, since it may write.
 */
export const commitV1Copy = Effect.fn("commitV1Copy")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS uncommitted_v1_copy`;
});
