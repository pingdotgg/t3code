// @effect-diagnostics nodeBuiltinImport:off - The supervisor lock is a native SQLite handle held for the runner's lifetime.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class DevRunnerStateDirInUseError extends Schema.TaggedError<DevRunnerStateDirInUseError>()(
  "DevRunnerStateDirInUseError",
  { stateDir: Schema.String, owner: Schema.String },
) {
  override get message(): string {
    return `Another dev runner already uses ${this.stateDir} (${this.owner}). Stop it, or pass --home-dir to use a separate T3 home.`;
  }
}

export class DevRunnerLockError extends Schema.TaggedError<DevRunnerLockError>()(
  "DevRunnerLockError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not lock ${this.stateDir} for this dev runner.`;
  }
}

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * One dev runner per state directory: its server restarts on every file change,
 * and the server's own ownership lock would hand the directory to whichever
 * runner restarts first. The OS releases this lock when the runner exits.
 */
export const acquireDevRunnerLock = Effect.fn("dev-runner.acquireDevRunnerLock")(function* (
  stateDir: string,
  owner: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ownerPath = path.join(stateDir, "dev-runner-owner.txt");
  yield* fs
    .makeDirectory(stateDir, { recursive: true })
    .pipe(Effect.mapError((cause) => new DevRunnerLockError({ stateDir, cause })));
  const opened = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(path.join(stateDir, "dev-runner.sqlite"));
        try {
          db.exec("BEGIN EXCLUSIVE;");
          return { db, busy: false };
        } catch (cause) {
          db.close();
          if (isSqliteBusy(cause)) return { db: undefined, busy: true };
          throw cause;
        }
      },
      catch: (cause) => new DevRunnerLockError({ stateDir, cause }),
    }),
    ({ db }) => Effect.sync(() => db?.close()),
  );
  if (opened.busy) {
    const recorded = yield* fs.readFileString(ownerPath).pipe(Effect.orElseSucceed(() => ""));
    return yield* new DevRunnerStateDirInUseError({
      stateDir,
      owner: recorded.trim() || "owner unknown",
    });
  }
  yield* fs
    .writeFileString(ownerPath, owner)
    .pipe(Effect.mapError((cause) => new DevRunnerLockError({ stateDir, cause })));
});
