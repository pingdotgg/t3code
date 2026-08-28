import { DesktopOpenAtLoginStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { getOpenAtLoginState, setOpenAtLogin } from "./openAtLogin.ts";

const decodeOpenAtLoginState = Schema.decodeUnknownEffect(DesktopOpenAtLoginStateSchema);

const invokeGetOpenAtLoginState = getOpenAtLoginState
  .handler(undefined)
  .pipe(Effect.flatMap(decodeOpenAtLoginState));
const invokeSetOpenAtLogin = (enabled: boolean) =>
  setOpenAtLogin.handler(enabled).pipe(Effect.flatMap(decodeOpenAtLoginState));

function environmentLayer(isPackaged: boolean, platform: NodeJS.Platform = "darwin") {
  return Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      isPackaged,
      platform,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );
}

function electronAppLayer(
  setLoginItemSettings: ElectronApp.ElectronApp["Service"]["setLoginItemSettings"] = () =>
    Effect.void,
) {
  return Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({
      setLoginItemSettings,
    } as ElectronApp.ElectronApp["Service"]),
  );
}

const withOpenAtLoginIpc = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppSettings.DesktopAppSettings
    | DesktopEnvironment.DesktopEnvironment
    | ElectronApp.ElectronApp
  >,
  input: {
    readonly isPackaged?: boolean;
    readonly setLoginItemSettings?: ElectronApp.ElectronApp["Service"]["setLoginItemSettings"];
  } = {},
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopAppSettings.layerTest(),
        environmentLayer(input.isPackaged ?? true),
        electronAppLayer(input.setLoginItemSettings),
      ),
    ),
  );

describe("desktop.ipc.openAtLogin", () => {
  it.effect("returns the persisted preference and packaged availability", () =>
    withOpenAtLoginIpc(
      Effect.gen(function* () {
        assert.deepEqual(yield* invokeGetOpenAtLoginState, {
          enabled: false,
          available: true,
        });
      }),
    ),
  );

  it.effect("enables the login item through IPC", () => {
    const calls: Array<{ readonly openAtLogin: boolean }> = [];
    const setLoginItemSettings: ElectronApp.ElectronApp["Service"]["setLoginItemSettings"] = (
      settings,
    ) =>
      Effect.sync(() => {
        calls.push(settings);
      });
    return withOpenAtLoginIpc(
      Effect.gen(function* () {
        assert.deepEqual(yield* invokeSetOpenAtLogin(true), {
          enabled: true,
          available: true,
        });
        assert.deepEqual(calls, [{ openAtLogin: true }]);
        assert.deepEqual(yield* invokeGetOpenAtLoginState, {
          enabled: true,
          available: true,
        });
      }),
      { setLoginItemSettings },
    );
  });
});
