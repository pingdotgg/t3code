import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as LinuxBrowserSecret from "./LinuxBrowserSecret.ts";

it.layer(NodeServices.layer)("Linux browser secret path", (it) => {
  it.effect("finds development and packaged helpers without falling back outside the install", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-browser-secret-path-" });
      const resourcesPath = path.join(root, "install", "resources");
      const native = path.join(
        root,
        "native",
        "browser-secret",
        "build",
        "x64",
        "t3-browser-secret",
      );
      const staged = path.join(
        root,
        "apps",
        "desktop",
        "prod-resources",
        "browser-secret",
        "t3-browser-secret",
      );
      const packaged = path.join(resourcesPath, "browser-secret", "t3-browser-secret");
      for (const filename of [native, staged, packaged]) {
        yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true });
        yield* fileSystem.writeFileString(filename, "helper");
      }
      const resolve = (isPackaged: boolean, platform: NodeJS.Platform = "linux") => {
        const environment = DesktopEnvironment.layer({
          dirname: path.join(root, "apps", "desktop", "dist-electron"),
          homeDirectory: root,
          platform,
          processArch: "x64",
          appVersion: "0.0.1",
          appPath: path.join(resourcesPath, "app.asar"),
          isPackaged,
          resourcesPath,
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(DesktopConfig.layerTest({})));
        return LinuxBrowserSecret.LinuxBrowserSecretPath.pipe(
          Effect.provide(LinuxBrowserSecret.layer.pipe(Layer.provide(environment))),
        );
      };

      assert.equal(yield* resolve(false), native);
      assert.equal(yield* resolve(true), packaged);
      yield* fileSystem.remove(native);
      assert.equal(yield* resolve(false), staged);
      yield* fileSystem.remove(packaged);
      assert.isUndefined(yield* resolve(true));
      assert.isUndefined(yield* resolve(false, "darwin"));
      assert.isUndefined(yield* resolve(false, "win32"));
      yield* fileSystem.remove(staged);
      assert.isUndefined(yield* resolve(false));
    }).pipe(Effect.scoped),
  );
});
