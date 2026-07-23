import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerCliBuildAssetMissingError } from "./cliErrors.ts";

export const copyRequiredBuildAsset = Effect.fn("copyRequiredBuildAsset")(function* (
  sourcePath: string,
  targetPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fileSystem.exists(sourcePath))) {
    return yield* new ServerCliBuildAssetMissingError({ assetPath: sourcePath });
  }

  yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
  yield* fileSystem.copyFile(sourcePath, targetPath);
});
