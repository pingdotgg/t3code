import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      // Rename swaps in the temp file's inode, so carry the target's mode over.
      // New files start owner-only since some (settings.json) can hold secrets.
      const mode = yield* fs.stat(input.filePath).pipe(
        Effect.map((info) => info.mode & 0o777),
        Effect.orElseSucceed(() => 0o600),
      );

      yield* fs.writeFileString(tempPath, input.contents);
      yield* fs.chmod(tempPath, mode);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
