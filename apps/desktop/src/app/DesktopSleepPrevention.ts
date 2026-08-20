import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

export const applyClientSettings = Effect.fn("desktop.sleepPrevention.applyClientSettings")(
  function* (settings: ClientSettings) {
    const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
    yield* powerSaveBlocker.setKeepAwake(settings.preventSleepForRemoteConnections);
  },
);

/** Restore the assertion before the backend starts, independently of a window. */
export const restore = Effect.fn("desktop.sleepPrevention.restore")(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const persistedSettings = yield* clientSettings.get;
  yield* applyClientSettings(Option.getOrElse(persistedSettings, () => DEFAULT_CLIENT_SETTINGS));
});
