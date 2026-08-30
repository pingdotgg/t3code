import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/** The Electron API subset used by this service, kept injectable for tests. */
export interface PowerSaveBlockerApi {
  start(type: "prevent-app-suspension" | "prevent-display-sleep"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

/**
 * Owns the process-wide assertion that lets the display turn off while
 * preventing automatic system sleep. The OS releases it when T3 Code exits.
 */
export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly setKeepAwake: (keepAwake: boolean) => Effect.Effect<void>;
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
          return;
        }
        if (blockerId !== null && api.isStarted(blockerId)) {
          api.stop(blockerId);
        }
        blockerId = null;
      }),
  });
};

export const layer = Layer.sync(ElectronPowerSaveBlocker, () => make(Electron.powerSaveBlocker));
