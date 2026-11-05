import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDesktopSshCliRunner } from "./DesktopSshEnvironment.ts";

const packagedEnvironment = DesktopEnvironment.DesktopEnvironment.pipe(
  Effect.provide(
    DesktopEnvironment.layer({
      dirname: "/Applications/T3 Code.app/Contents/Resources/app.asar/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.22",
      appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
      ),
    ),
  ),
);

describe("resolveDesktopSshCliRunner", () => {
  it.effect("downloads the remote runner from the release mirror", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(environment, {
        [CLI_RELEASE_BASE_URL_ENV]: "https://mirror.example.com/t3code",
      });

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.0.22",
        releaseBaseUrl: "https://mirror.example.com/t3code",
      });
    }),
  );
});
