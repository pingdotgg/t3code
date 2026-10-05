import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopState from "../../app/DesktopState.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** The renderer turns this on while Home is on, so its relay survives a closed window. */
export const setKeepAliveOnClose = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_KEEP_ALIVE_ON_CLOSE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.setKeepAliveOnClose")(function* (keepAlive) {
    const state = yield* DesktopState.DesktopState;
    yield* Ref.set(state.keepAliveOnClose, keepAlive);
  }),
});
