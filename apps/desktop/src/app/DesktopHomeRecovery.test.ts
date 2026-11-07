import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopHomeRecovery from "./DesktopHomeRecovery.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

it.effect.each([
  { response: 0, failWrite: false, disabled: false },
  { response: 1, failWrite: false, disabled: true },
  { response: 1, failWrite: true, disabled: false },
])("recovers an owned T3 home with $response and failWrite=$failWrite", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-home-recovery-" });
      const environment = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: home,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "0.1.6",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: home })));
      const events: string[] = [];
      const record = (event: string) =>
        Effect.sync(() => {
          events.push(event);
        });
      yield* Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const env = yield* DesktopEnvironment.DesktopEnvironment;
        yield* settings.load;
        yield* settings.setWslBackendEnabled(true);
        if (scenario.failWrite) {
          yield* fs.remove(env.desktopSettingsPath);
          yield* fs.makeDirectory(env.desktopSettingsPath);
        }
        yield* DesktopHomeRecovery.recover();
        expect((yield* settings.get).localEnvironmentEnabled).toBe(!scenario.disabled);
        expect((yield* settings.get).wslBackendEnabled).toBe(true);
        if (!scenario.failWrite) {
          expect((yield* settings.load).localEnvironmentEnabled).toBe(!scenario.disabled);
        }
        expect(events).toEqual(
          scenario.disabled ? ["relaunch"] : scenario.failWrite ? ["error", "quit"] : ["quit"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopAppSettings.layer.pipe(Layer.provideMerge(environment)),
            DesktopState.layer,
            DesktopShutdown.layer,
            Layer.succeed(
              DesktopWindow.DesktopWindow,
              {} as DesktopWindow.DesktopWindow["Service"],
            ),
            Layer.succeed(
              ElectronTheme.ElectronTheme,
              {} as ElectronTheme.ElectronTheme["Service"],
            ),
            Layer.succeed(DesktopLifecycle.DesktopLifecycle, {
              register: Effect.void,
              relaunch: () => record("relaunch"),
            }),
            Layer.succeed(ElectronApp.ElectronApp, {
              quit: record("quit"),
            } as ElectronApp.ElectronApp["Service"]),
            Layer.succeed(ElectronDialog.ElectronDialog, {
              pickFolder: () => Effect.die("unexpected folder picker"),
              pickFiles: () => Effect.die("unexpected file picker"),
              showMessageBox: () =>
                Effect.succeed({ response: scenario.response, checkboxChecked: false }),
              showErrorBox: () => record("error"),
            }),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
