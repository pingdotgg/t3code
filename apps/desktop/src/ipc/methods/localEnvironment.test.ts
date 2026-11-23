import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopBackgroundService from "../../backend/DesktopBackgroundService.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopTray from "../../window/DesktopTray.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  disableBackgroundService,
  enableBackgroundService,
  getBackgroundServiceState,
  getHostEnvironmentId,
  getLocalEnvironmentEnabled,
  setLocalEnvironmentEnabled,
} from "./localEnvironment.ts";

const layerUnusedLifecycleRuntime = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.mock(DesktopWindow.DesktopWindow, {}),
  Layer.mock(ElectronApp.ElectronApp, {}),
  Layer.mock(ElectronTheme.ElectronTheme, {}),
);

describe("local environment IPC", () => {
  it.effect("reads the shared home identity without creating one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const environment = DesktopEnvironment.DesktopEnvironment.of({
        path,
        stateDir,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const read = getHostEnvironmentId
        .handler(undefined)
        .pipe(Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment));
      assert.strictEqual(yield* read, null);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "environment-id")));
      yield* fs.writeFileString(path.join(stateDir, "environment-id"), "  service-id\n");
      assert.strictEqual(yield* read, "service-id");
      yield* fs.writeFileString(path.join(stateDir, "environment-id"), "\n");
      assert.strictEqual(yield* read, null);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("relaunches only when the setting changes and keeps other settings", () => {
    const relaunchReasons: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: true,
      }),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, {
        relaunch: (reason) =>
          Effect.sync(() => {
            relaunchReasons.push(reason);
          }),
      }),
      layerUnusedLifecycleRuntime,
    );
    return Effect.gen(function* () {
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.isFalse(yield* getLocalEnvironmentEnabled.handler());
      yield* setLocalEnvironmentEnabled.handler(false);
      assert.deepEqual(relaunchReasons, ["localEnvironmentEnabled=false"]);

      yield* setLocalEnvironmentEnabled.handler(true);
      assert.isTrue(yield* getLocalEnvironmentEnabled.handler());
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      assert.isTrue((yield* appSettings.get).wslBackendEnabled);
      assert.deepEqual(relaunchReasons, [
        "localEnvironmentEnabled=false",
        "localEnvironmentEnabled=true",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("toggles background service setting immediately and syncs the system tray", () =>
    Effect.gen(function* () {
      let traySyncCount = 0;
      const settingsLayer = DesktopAppSettings.layerTest(
        DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      );
      const trayLayer = Layer.succeed(DesktopTray.DesktopTray, {
        sync: Effect.sync(() => {
          traySyncCount += 1;
        }),
        destroy: Effect.void,
      });
      const backgroundServiceLayer = Layer.effect(
        DesktopBackgroundService.DesktopBackgroundService,
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          return DesktopBackgroundService.DesktopBackgroundService.of({
            attached: Effect.succeedNone,
            tryAttach: Effect.succeedNone,
            clearAttached: Effect.void,
            issueBearerToken: Effect.die("unexpected token"),
            status: settings.get.pipe(
              Effect.map((current) => ({
                supported: true,
                enabled: current.backgroundServiceEnabled,
                running: false,
                attached: false,
                externalService: false,
                version: null,
              })),
            ),
          });
        }),
      ).pipe(Layer.provideMerge(settingsLayer), Layer.provideMerge(trayLayer));

      const initial = yield* getBackgroundServiceState
        .handler(undefined)
        .pipe(Effect.provide(backgroundServiceLayer));
      assert.deepEqual(initial, {
        supported: true,
        enabled: false,
        running: false,
        attached: false,
        externalService: false,
        version: null,
      });

      const enabled = yield* enableBackgroundService
        .handler(undefined)
        .pipe(Effect.provide(backgroundServiceLayer));
      assert.deepEqual(enabled, {
        supported: true,
        enabled: true,
        running: false,
        attached: false,
        externalService: false,
        version: null,
      });
      assert.strictEqual(traySyncCount, 1);

      const disabled = yield* disableBackgroundService
        .handler(undefined)
        .pipe(Effect.provide(backgroundServiceLayer));
      assert.deepEqual(disabled, {
        supported: true,
        enabled: false,
        running: false,
        attached: false,
        externalService: false,
        version: null,
      });
      assert.strictEqual(traySyncCount, 2);
    }),
  );
});
