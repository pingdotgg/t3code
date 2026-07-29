import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { configureElectronStoragePaths } from "./DesktopApp.ts";

describe("configureElectronStoragePaths", () => {
  it.effect("creates a fresh split-layout cache directory before configuring Electron", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-electron-storage-",
      });
      const electronCachePath = `${root}/cache/electron`;
      const configuredPaths: Array<readonly [string, string]> = [];
      const electronAppLayer = Layer.succeed(
        ElectronApp.ElectronApp,
        ElectronApp.ElectronApp.of({
          setPath: (name, path) =>
            name === "cache"
              ? fileSystem.exists(path).pipe(
                  Effect.map((exists) => {
                    assert.isTrue(exists);
                    configuredPaths.push([name, path]);
                  }),
                )
              : Effect.sync(() => {
                  configuredPaths.push([name, path]);
                }),
        } as ElectronApp.ElectronApp["Service"]),
      );

      yield* configureElectronStoragePaths({
        userDataPath: `${root}/state/electron`,
        storageLayout: "split",
        electronCachePath,
      }).pipe(Effect.provide(electronAppLayer));

      assert.deepEqual(configuredPaths, [
        ["userData", `${root}/state/electron`],
        ["cache", electronCachePath],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
