import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

describe("DesktopAssets", () => {
  it.effect("uses canonical source-tree icons for unpackaged development", () =>
    Effect.gen(function* () {
      const developmentEnvironmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/Users/alice",
        platform: "linux",
        processArch: "x64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: false,
        resourcesPath: "/repo/apps/desktop/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodePath.layerPosix,
            DesktopConfig.layerTest({ VITE_DEV_SERVER_URL: "http://localhost:5733" }),
          ),
        ),
      );
      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) => Effect.succeed(String(path).includes("/assets/dev/")),
      });
      const assets = yield* DesktopAssets.DesktopAssets.pipe(
        Effect.provide(
          DesktopAssets.layer.pipe(
            Layer.provide(Layer.merge(fileSystemLayer, developmentEnvironmentLayer)),
          ),
        ),
      );

      const icons = yield* assets.iconPaths;

      assert.match(Option.getOrThrow(icons.ico), /assets\/dev\/blueprint-windows\.ico$/);
      assert.match(Option.getOrThrow(icons.png), /assets\/dev\/blueprint-universal-1024\.png$/);
      assert.isTrue(Option.isNone(icons.icns));
    }),
  );
});
