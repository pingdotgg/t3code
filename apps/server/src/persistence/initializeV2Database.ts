import * as NodeWorkerThreads from "node:worker_threads";

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

// V1 files predate auto_vacuum, and a page backup would keep that. VACUUM INTO compacts the copy and
// enables incremental mode, so the server can return freed pages; the worker keeps it off the event loop.
const snapshotWorkerSource = `
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(workerData.sourcePath, { readOnly: true });
try {
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  database.prepare("VACUUM INTO ?").run(workerData.snapshotPath);
} finally {
  database.close();
}
`;

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
    yield* Effect.callback<void, V2DatabaseImportError>((resume) => {
      const fail = (cause: unknown) =>
        resume(Effect.fail(new V2DatabaseImportError({ sourcePath, destinationPath, cause })));
      const worker = new NodeWorkerThreads.Worker(snapshotWorkerSource, {
        eval: true,
        workerData: { sourcePath, snapshotPath },
      });
      worker.once("error", fail);
      worker.once("exit", (code) =>
        code === 0 ? resume(Effect.void) : fail(new Error(`Snapshot worker exited with ${code}`)),
      );
      // Interruption waits for the worker to exit before the scope removes its directory.
      return Effect.promise(() => worker.terminate());
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
