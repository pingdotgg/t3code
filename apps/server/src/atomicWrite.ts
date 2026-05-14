import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* Random.nextUUIDv4;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      yield* fs.writeFileString(tempPath, input.contents);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
