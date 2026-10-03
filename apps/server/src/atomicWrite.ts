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

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(targetPath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      yield* fs.rename(tempPath, targetPath);
    }),
  );
