import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronPowerSaveBlocker from "../../electron/ElectronPowerSaveBlocker.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setKeepAwake = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_KEEP_AWAKE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.power.setKeepAwake")(function* (keepAwake) {
    const blocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
    return yield* blocker.setKeepAwake(keepAwake);
  }),
});
