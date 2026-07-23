import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copyRequiredBuildAsset } from "./cliBuildAssets.ts";

it.layer(NodeServices.layer)("server CLI build assets", (it) => {
  it.effect("fails when a required build asset is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cli-required-asset-",
      });
      const sourcePath = path.join(tempDir, "missing.ts");
      const targetPath = path.join(tempDir, "dist", "required.ts");

      const error = yield* copyRequiredBuildAsset(sourcePath, targetPath).pipe(Effect.flip);

      assert.equal(error._tag, "ServerCliBuildAssetMissingError");
      if (error._tag !== "ServerCliBuildAssetMissingError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.assetPath, sourcePath);
      assert.equal(yield* fileSystem.exists(targetPath), false);
    }),
  );

  it.effect("copies a required build asset into its target directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cli-required-asset-",
      });
      const sourcePath = path.join(tempDir, "required.ts");
      const targetPath = path.join(tempDir, "dist", "assets", "required.ts");
      yield* fileSystem.writeFileString(sourcePath, "export const required = true;\n");

      yield* copyRequiredBuildAsset(sourcePath, targetPath);

      assert.equal(yield* fileSystem.readFileString(targetPath), "export const required = true;\n");
    }),
  );
});
