import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLI_RELEASE_BASE_URL_ENV } from "@lathe/shared/cliRelease";
import * as NetService from "@lathe/shared/Net";
import { SshCommandError } from "@lathe/ssh/errors";
import { SshOutputObserver } from "@lathe/ssh/output";
import * as SshTunnel from "@lathe/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshOutputLog from "./DesktopSshOutputLog.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

const packagedEnvironment = DesktopEnvironment.DesktopEnvironment.pipe(
  Effect.provide(
    DesktopEnvironment.layer({
      dirname: "/Applications/Lathe.app/Contents/Resources/app.asar/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.22",
      appPath: "/Applications/Lathe.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Lathe.app/Contents/Resources",
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

      const runner = DesktopSshEnvironment.resolveDesktopSshCliRunner(environment, {
        [CLI_RELEASE_BASE_URL_ENV]: "https://mirror.example.com/t3code",
      });

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.0.22",
        nodeEngineRange: serverPackageJson.engines.node,
        releaseBaseUrl: "https://mirror.example.com/t3code",
      });
    }),
  );
});

// Fork: the per-environment SSH output log.
describe("sshEnvironment", () => {
  it.effect("records each attempt's output between its start and outcome", () => {
    const target = { alias: "devbox", hostname: "devbox.example.com", username: null, port: null };
    return Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const log = yield* DesktopSshOutputLog.DesktopSshOutputLog;

      const failure = yield* Effect.flip(sshEnvironment.ensureEnvironment(target));
      assert.equal(failure.message, "SSH command timed out after 90000ms.");

      const { entries } = yield* log.subscribe(target);
      assert.deepEqual(
        entries.map((entry) => [entry.source, entry.text]),
        [
          ["status", "Connecting to devbox"],
          ["launch", "installing lathe 1.2.3"],
          ["status", "Failed: SSH command timed out after 90000ms."],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.effect(DesktopSshEnvironment.DesktopSshEnvironment, DesktopSshEnvironment.make).pipe(
          Layer.provideMerge(
            Layer.mock(SshTunnel.SshEnvironmentManager)({
              ensureEnvironment: () =>
                Effect.gen(function* () {
                  const observe = yield* SshOutputObserver;
                  yield* observe({
                    source: "launch",
                    stream: "stderr",
                    text: "installing lathe 1.2.3\n",
                  });
                  return yield* new SshCommandError({
                    command: ["ssh"],
                    exitCode: null,
                    stderr: "",
                    timedOut: true,
                    message: "SSH command timed out after 90000ms.",
                  });
                }),
            }),
          ),
          Layer.provideMerge(
            DesktopSshOutputLog.layer.pipe(
              Layer.provide(
                Layer.mock(ElectronWindow.ElectronWindow)({ sendAll: () => Effect.void }),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
            }),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
    );
  });
});
