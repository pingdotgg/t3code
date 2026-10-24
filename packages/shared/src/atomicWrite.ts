import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

/**
 * Windows refuses to rename over or away from a file another process holds open
 * without delete sharing, such as a virus scanner or the search indexer. The same
 * codes also mean a denial that never clears, so retries need a bound.
 */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// About 2 seconds in total. Settings and keybinding saves wait on this while holding
// their write lock, so a denial that is not a brief scan has to surface quickly.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

// A save keeps the permissions of the file it replaces, so a private file stays
// private, and a new file is readable only by its owner. chmod rather than an open
// mode, because the umask narrows the latter.
const replacedMode = (fs: FileSystem.FileSystem, targetPath: string) =>
  fs.stat(targetPath).pipe(
    Effect.map((info) => info.mode & 0o777),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(0o600),
    ),
  );

const isUnsupportedSync = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS";
};

/**
 * A symlinked target is resolved first so the link survives and its destination is
 * rewritten, since renaming over the link itself would swap it for a regular file.
 */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Opened before anything is written, so a directory that cannot be opened
      // (one without read permission) fails the save while the target is intact.
      // Windows cannot open a directory to sync it.
      const directory =
        platform === "win32" ? undefined : yield* fs.open(targetDirectory, { flag: "r" });
      // The temp directory is cleanup, not part of the write: failing to remove
      // it (a virus scanner holding it on Windows) must not fail a write that
      // already landed.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: `${path.basename(targetPath)}.`,
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      // The handle opens before the chmod, which may drop write access, and closes
      // before the rename, which Windows refuses while it is open. The sync flushes
      // the contents and the mode, or a crash soon after the rename can leave the
      // target empty. Windows modes carry only the read-only bit, which the rename
      // below handles.
      yield* fs.open(tempPath, { flag: "r+" }).pipe(
        Effect.tap(() =>
          platform === "win32"
            ? Effect.void
            : replacedMode(fs, targetPath).pipe(Effect.flatMap((mode) => fs.chmod(tempPath, mode))),
        ),
        Effect.flatMap((file) => file.sync),
        Effect.scoped,
      );
      if (directory !== undefined) {
        yield* fs.rename(tempPath, targetPath);
        // Persists the rename. Only a filesystem that cannot sync a directory at all
        // is let through: the rename is visible, but a failed sync means it may not
        // survive a crash.
        return yield* directory.sync.pipe(
          Effect.catchIf(isUnsupportedSync, (error) => Effect.logWarning(error)),
        );
      }

      // A retry must not replace a save another process landed while this one
      // waited, so it gives up once the target is no longer the file seen here.
      // A read-only target fails with the same EPERM as a held one but never clears.
      const targetVersion = fs.stat(targetPath).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0,
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );
