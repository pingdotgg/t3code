import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";
import * as DesktopLoginItem from "./DesktopLoginItem.ts";

function environmentLayer(isPackaged: boolean) {
  return Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      isPackaged,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );
}

function electronAppLayer(
  setLoginItemSettings: ElectronApp.ElectronApp["Service"]["setLoginItemSettings"],
) {
  return Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({
      setLoginItemSettings,
    } as ElectronApp.ElectronApp["Service"]),
  );
}

function recordingSetLoginItemSettings() {
  const calls: Array<{ readonly openAtLogin: boolean }> = [];
  const setLoginItemSettings: ElectronApp.ElectronApp["Service"]["setLoginItemSettings"] = (
    settings,
  ) =>
    Effect.sync(() => {
      calls.push(settings);
    });
  return { calls, setLoginItemSettings };
}

const withLoginItem = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppSettings.DesktopAppSettings
    | DesktopEnvironment.DesktopEnvironment
    | ElectronApp.ElectronApp
  >,
  input: {
    readonly isPackaged: boolean;
    readonly setLoginItemSettings?: ElectronApp.ElectronApp["Service"]["setLoginItemSettings"];
    readonly initialOpenAtLogin?: boolean;
  },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          openAtLogin: input.initialOpenAtLogin ?? false,
        }),
        environmentLayer(input.isPackaged),
        electronAppLayer(input.setLoginItemSettings ?? (() => Effect.void)),
      ),
    ),
  );

describe("DesktopLoginItem", () => {
  it.effect("registers a packaged app as a login item and persists the preference", () => {
    const { calls, setLoginItemSettings } = recordingSetLoginItemSettings();
    return withLoginItem(
      Effect.gen(function* () {
        const state = yield* DesktopLoginItem.setOpenAtLogin(true);
        assert.deepEqual(state, { enabled: true, available: true });
        assert.deepEqual(calls, [{ openAtLogin: true }]);

        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.equal((yield* settings.get).openAtLogin, true);
      }),
      { isPackaged: true, setLoginItemSettings },
    );
  });

  it.effect("skips OS registration for unpackaged builds and still persists", () => {
    const { calls, setLoginItemSettings } = recordingSetLoginItemSettings();
    return withLoginItem(
      Effect.gen(function* () {
        const state = yield* DesktopLoginItem.setOpenAtLogin(true);
        assert.deepEqual(state, { enabled: true, available: false });
        assert.equal(calls.length, 0);

        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.equal((yield* settings.get).openAtLogin, true);
      }),
      { isPackaged: false, setLoginItemSettings },
    );
  });

  it.effect("does not persist when OS registration fails", () => {
    const cause = new Error("registry write failed");
    return withLoginItem(
      Effect.gen(function* () {
        const error = yield* DesktopLoginItem.setOpenAtLogin(true).pipe(Effect.flip);
        assert.instanceOf(error, ElectronApp.ElectronLoginItemSettingsError);
        assert.strictEqual(error.openAtLogin, true);
        assert.strictEqual(error.cause, cause);

        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.equal((yield* settings.get).openAtLogin, false);
      }),
      {
        isPackaged: true,
        setLoginItemSettings: () =>
          Effect.fail(
            new ElectronApp.ElectronLoginItemSettingsError({
              openAtLogin: true,
              cause,
            }),
          ),
      },
    );
  });

  it.effect("applies the persisted preference without rewriting settings", () => {
    const { calls, setLoginItemSettings } = recordingSetLoginItemSettings();
    return withLoginItem(
      Effect.gen(function* () {
        yield* DesktopLoginItem.applyOpenAtLogin(true);
        assert.deepEqual(calls, [{ openAtLogin: true }]);
      }),
      { isPackaged: true, setLoginItemSettings, initialOpenAtLogin: true },
    );
  });
});
