import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  getHomeEnvironmentId,
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

  it.effect("reads the environment ID of whichever server owns the T3 home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped();
      let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
      // Registered through the real sync IPC path, which replies via Effect.runSync.
      yield* DesktopIpc.make({
        removeHandler: () => {},
        handle: () => {},
        removeAllListeners: () => {},
        on: (_channel, registered) => {
          listener = registered;
        },
      })
        .handleSync(getHomeEnvironmentId)
        .pipe(
          Effect.provideService(
            DesktopEnvironment.DesktopEnvironment,
            DesktopEnvironment.DesktopEnvironment.of({
              path,
              stateDir,
            } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
        );
      const readHomeEnvironmentId = () => {
        const event = { returnValue: undefined as unknown };
        listener?.(event);
        return event.returnValue;
      };

      assert.isNull(readHomeEnvironmentId());
      yield* fileSystem.writeFileString(path.join(stateDir, "environment-id"), "env-home-1\n");
      assert.strictEqual(readHomeEnvironmentId(), "env-home-1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
