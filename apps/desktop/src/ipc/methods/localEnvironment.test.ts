import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopBackgroundService from "../../backend/DesktopBackgroundService.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
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

  it.effect(
    "stops the embedded backend before installing the background service and relaunches",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const events: Array<string> = [];
        let installed = false;
        const layer = Layer.mergeAll(
          DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            stateDir,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.mock(DesktopLifecycle.DesktopLifecycle, {
            relaunch: (reason) =>
              Effect.sync(() => {
                events.push(`relaunch:${reason}`);
              }),
          }),
          Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
            primary: Effect.succeed({
              id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
              label: Effect.succeed("Windows"),
              start: Effect.sync(() => {
                events.push("primary:start");
              }),
              stop: () =>
                Effect.sync(() => {
                  events.push("primary:stop");
                }),
              currentConfig: Effect.succeedNone,
              snapshot: Effect.die("unexpected snapshot"),
              waitForReady: () => Effect.succeed(true),
            }),
          } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
          Layer.succeed(DesktopBackgroundService.DesktopBackgroundService, {
            attached: Effect.succeedNone,
            tryAttach: Effect.succeedNone,
            clearAttached: Effect.sync(() => {
              events.push("clear-attached");
            }),
            issueBearerToken: Effect.die("unexpected token"),
            status: Effect.sync(() => ({
              supported: true,
              installed,
              running: installed,
              attached: false,
              otherBaseDir: null,
              version: installed ? "0.1.11" : null,
            })),
            install: Effect.sync(() => {
              events.push("service:install");
              installed = true;
            }),
            uninstall: Effect.sync(() => {
              events.push("service:uninstall");
              installed = false;
            }),
          }),
          DesktopShutdown.layer,
          DesktopState.layer,
          Layer.mock(DesktopWindow.DesktopWindow, {}),
          Layer.mock(ElectronApp.ElectronApp, {}),
          Layer.mock(ElectronTheme.ElectronTheme, {}),
        );

        const initial = yield* getBackgroundServiceState
          .handler(undefined)
          .pipe(Effect.provide(layer));
        assert.deepEqual(initial, {
          supported: true,
          installed: false,
          running: false,
          attached: false,
          otherBaseDir: null,
          version: null,
        });

        const enabled = yield* enableBackgroundService
          .handler(undefined)
          .pipe(Effect.provide(layer));
        assert.deepEqual(enabled, {
          supported: true,
          installed: true,
          running: true,
          attached: false,
          otherBaseDir: null,
          version: "0.1.11",
        });
        assert.deepEqual(events, [
          "primary:stop",
          "service:install",
          "relaunch:backgroundService=enabled",
        ]);

        const disabled = yield* disableBackgroundService
          .handler(undefined)
          .pipe(Effect.provide(layer));
        assert.deepEqual(disabled, {
          supported: true,
          installed: false,
          running: false,
          attached: false,
          otherBaseDir: null,
          version: null,
        });
        assert.deepEqual(events, [
          "primary:stop",
          "service:install",
          "relaunch:backgroundService=enabled",
          "service:uninstall",
          "clear-attached",
          "relaunch:backgroundService=disabled",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restarts the embedded backend if background service installation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const events: Array<string> = [];
      const layer = Layer.mergeAll(
        DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.mock(DesktopLifecycle.DesktopLifecycle, {
          relaunch: (reason) =>
            Effect.sync(() => {
              events.push(`relaunch:${reason}`);
            }),
        }),
        Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
          primary: Effect.succeed({
            id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
            label: Effect.succeed("Windows"),
            start: Effect.sync(() => {
              events.push("primary:start");
            }),
            stop: () =>
              Effect.sync(() => {
                events.push("primary:stop");
              }),
            currentConfig: Effect.succeedNone,
            snapshot: Effect.die("unexpected snapshot"),
            waitForReady: () => Effect.succeed(true),
          }),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
        Layer.succeed(DesktopBackgroundService.DesktopBackgroundService, {
          attached: Effect.succeedNone,
          tryAttach: Effect.succeedNone,
          clearAttached: Effect.void,
          issueBearerToken: Effect.die("unexpected token"),
          status: Effect.succeed({
            supported: true,
            installed: false,
            running: false,
            attached: false,
            otherBaseDir: null,
            version: null,
          }),
          install: Effect.fail(
            new DesktopBackgroundService.DesktopBackgroundServiceError({
              operation: "install",
              message: "schtasks failed",
            }),
          ),
          uninstall: Effect.void,
        }),
        DesktopShutdown.layer,
        DesktopState.layer,
        Layer.mock(DesktopWindow.DesktopWindow, {}),
        Layer.mock(ElectronApp.ElectronApp, {}),
        Layer.mock(ElectronTheme.ElectronTheme, {}),
      );

      const outcome = yield* enableBackgroundService
        .handler(undefined)
        .pipe(Effect.result, Effect.provide(layer));
      assert.isTrue(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "DesktopBackgroundServiceError");
      }
      assert.deepEqual(events, ["primary:stop", "primary:start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
