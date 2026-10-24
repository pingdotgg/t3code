import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { mergeReleaseUpdateManifestFiles } from "./merge-release-update-manifests.ts";

const manifest = (fileName: string) => `version: 1.2.3
files:
  - url: ${fileName}
    sha512: ${fileName}-sha
    size: 123
releaseDate: '2026-10-22T00:00:00.000Z'
`;

it.layer(NodeServices.layer)("merge release update manifests", (it) => {
  it.effect("merges complete macOS and Windows architecture pairs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const releaseAssetsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "merge-release-update-manifests-",
      });
      const fixtures = {
        "latest-mac.yml": manifest("T3-Code-1.2.3-arm64.zip"),
        "latest-mac-x64.yml": manifest("T3-Code-1.2.3-x64.zip"),
        "latest-win-arm64.yml": manifest("T3-Code-1.2.3-arm64.exe"),
        "latest-win-x64.yml": manifest("T3-Code-1.2.3-x64.exe"),
      };
      yield* Effect.forEach(Object.entries(fixtures), ([fileName, contents]) =>
        fs.writeFileString(path.join(releaseAssetsDir, fileName), contents),
      );

      yield* mergeReleaseUpdateManifestFiles(releaseAssetsDir);

      const mac = yield* fs.readFileString(path.join(releaseAssetsDir, "latest-mac.yml"));
      const win = yield* fs.readFileString(path.join(releaseAssetsDir, "latest.yml"));
      assert.include(mac, "T3-Code-1.2.3-arm64.zip");
      assert.include(mac, "T3-Code-1.2.3-x64.zip");
      assert.include(win, "T3-Code-1.2.3-arm64.exe");
      assert.include(win, "T3-Code-1.2.3-x64.exe");
      assert.isFalse(yield* fs.exists(path.join(releaseAssetsDir, "latest-mac-x64.yml")));
      assert.isFalse(yield* fs.exists(path.join(releaseAssetsDir, "latest-win-arm64.yml")));
      assert.isFalse(yield* fs.exists(path.join(releaseAssetsDir, "latest-win-x64.yml")));
    }),
  );

  it.effect.each([
    {
      platform: "macOS",
      fixtures: ["latest-mac.yml", "latest-win-arm64.yml", "latest-win-x64.yml"],
    },
    {
      platform: "macOS",
      fixtures: ["latest-mac-x64.yml", "latest-win-arm64.yml", "latest-win-x64.yml"],
    },
    {
      platform: "Windows",
      fixtures: ["latest-mac.yml", "latest-mac-x64.yml", "latest-win-arm64.yml"],
    },
    {
      platform: "Windows",
      fixtures: ["latest-mac.yml", "latest-mac-x64.yml", "latest-win-x64.yml"],
    },
  ] as const)("refuses a one-architecture $platform release", ({ platform, fixtures }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const releaseAssetsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "merge-release-update-manifests-incomplete-",
      });
      yield* Effect.forEach(fixtures, (fileName) =>
        fs.writeFileString(path.join(releaseAssetsDir, fileName), manifest(fileName)),
      );

      const exit = yield* mergeReleaseUpdateManifestFiles(releaseAssetsDir).pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      assert.include(String(exit), `Incomplete ${platform} updater manifests`);
    }),
  );
});
