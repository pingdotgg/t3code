import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

/**
 * Replaces a file's contents via a sibling temp file and rename. A symlinked
 * target is resolved first so the link survives and its destination is
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
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      // The rename replaces the inode, so carry the target's permission bits over
      // (these files can hold secrets); new files start owner-only.
      const mode = yield* fs.stat(targetPath).pipe(
        Effect.map((info) => info.mode & 0o777),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0o600)),
      );

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
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
      // chmod, not a write `mode`, because the umask would mask it; the temp directory is 0700.
      yield* fs.chmod(tempPath, mode);
      yield* fs.rename(tempPath, targetPath);
    }),
  );
