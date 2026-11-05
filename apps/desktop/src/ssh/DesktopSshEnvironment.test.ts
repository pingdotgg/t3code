import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";

const runnerScript = (env: Record<string, string | undefined>) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.map((environment) =>
      buildRemoteT3RunnerScript(DesktopSshEnvironment.resolveCliRunner(environment)),
    ),
    Effect.provide(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/home/alice",
        platform: "linux",
        processArch: "x64",
        appVersion: "0.1.6",
        appPath: "/opt/t3code/resources/app.asar",
        isPackaged: true,
        resourcesPath: "/opt/t3code/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
        ),
      ),
    ),
  );

describe("resolveCliRunner", () => {
  it.effect("downloads the remote runtime from T3CODE_RELEASE_BASE_URL", () =>
    Effect.gen(function* () {
      const cases = [
        [{ T3CODE_RELEASE_BASE_URL: "https://mirror.example/t3/" }, "https://mirror.example/t3"],
        [
          { T3CODE_RELEASE_BASE_URL: "  " },
          "https://github.com/pingdotgg/t3code/releases/download",
        ],
        [{}, "https://github.com/pingdotgg/t3code/releases/download"],
      ] as const;
      for (const [env, expected] of cases) {
        const script = yield* runnerScript(env);
        assert.include(script, `T3_RELEASE_BASE_URL='${expected}'`);
        assert.include(script, `T3_ARCHIVE_VERSION='0.1.6'`);
      }
    }),
  );
});
