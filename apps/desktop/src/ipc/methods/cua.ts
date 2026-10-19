import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCuaDriver from "../../cua/DesktopCuaDriver.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const restartCuaDriver = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTART_CUA_DRIVER_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cua.restart")(function* () {
    yield* (yield* DesktopCuaDriver.DesktopCuaDriver).restart;
  }),
});
