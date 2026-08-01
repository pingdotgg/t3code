import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdateRelaunch from "./DesktopUpdateRelaunch.ts";

const withRelaunchMarker = <A, E>(
  effect: Effect.Effect<A, E, DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-update-relaunch-test-",
    });
    const environmentLayer = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: baseDir,
      platform: "linux",
      processArch: "x64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
      ),
    );
    return yield* effect.pipe(Effect.provide(Layer.merge(NodeServices.layer, environmentLayer)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopUpdateRelaunch", () => {
  it.effect("persists a marker that can be consumed exactly once", () =>
    withRelaunchMarker(
      Effect.gen(function* () {
        assert.isFalse(yield* DesktopUpdateRelaunch.consume);
        yield* DesktopUpdateRelaunch.mark;
        assert.isTrue(yield* DesktopUpdateRelaunch.consume);
        assert.isFalse(yield* DesktopUpdateRelaunch.consume);
      }),
    ),
  );

  it.effect("clears a marker after an aborted install", () =>
    withRelaunchMarker(
      Effect.gen(function* () {
        yield* DesktopUpdateRelaunch.mark;
        yield* DesktopUpdateRelaunch.clear;
        assert.isFalse(yield* DesktopUpdateRelaunch.consume);
      }),
    ),
  );
});
