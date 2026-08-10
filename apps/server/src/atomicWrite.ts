import { retryWindowsFileSystemOperation } from "@t3tools/shared/windowsFileRetry";
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

      yield* retryWindowsFileSystemOperation(
        fs.makeDirectory(targetDirectory, { recursive: true }),
      );
      const tempDirectory = yield* retryWindowsFileSystemOperation(
        fs.makeTempDirectoryScoped({
          directory: targetDirectory,
          prefix: `${path.basename(input.filePath)}.`,
        }),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* retryWindowsFileSystemOperation(fs.writeFileString(tempPath, input.contents));
      yield* retryWindowsFileSystemOperation(fs.rename(tempPath, input.filePath));
    }),
  );
