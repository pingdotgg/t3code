import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/**
 * The subset of `Electron.powerSaveBlocker` the service needs, injectable so
 * tests can observe start/stop calls without an Electron runtime.
 */
export interface PowerSaveBlockerApi {
  start(type: "prevent-app-suspension" | "prevent-display-sleep"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

/**
 * Holds at most one `prevent-app-suspension` power-save blocker for the whole
 * app, toggled by the renderer while a locally hosted agent is working. The
 * single slot is last-writer-wins across windows; the desktop runs one main
 * window today. No app-quit cleanup is needed: the OS releases the assertion
 * when the process exits.
 */
export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly setKeepAwake: (keepAwake: boolean) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

export const make = (api: PowerSaveBlockerApi): ElectronPowerSaveBlocker["Service"] => {
  let blockerId: number | null = null;

  const isHeld = () => blockerId !== null && api.isStarted(blockerId);

  return ElectronPowerSaveBlocker.of({
    setKeepAwake: (keepAwake) =>
      Effect.sync(() => {
        if (keepAwake) {
          if (!isHeld()) {
            blockerId = api.start("prevent-app-suspension");
          }
          return true;
        }
        if (blockerId !== null && api.isStarted(blockerId)) {
          api.stop(blockerId);
        }
        blockerId = null;
        return false;
      }),
  });
};

export const layer = Layer.sync(ElectronPowerSaveBlocker, () => make(Electron.powerSaveBlocker));
