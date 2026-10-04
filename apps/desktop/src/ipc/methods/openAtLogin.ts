import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopMacLoginItem from "../../app/DesktopMacLoginItem.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getOpenAtLogin = makeSyncIpcMethod({
  channel: IpcChannels.GET_OPEN_AT_LOGIN_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.openAtLogin.get")(function* () {
    const loginItem = yield* DesktopMacLoginItem.DesktopMacLoginItem;
    return yield* loginItem.getOpenAtLogin;
  }),
});

export const setOpenAtLogin = makeIpcMethod({
  channel: IpcChannels.SET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.openAtLogin.set")(function* (enabled) {
    const loginItem = yield* DesktopMacLoginItem.DesktopMacLoginItem;
    yield* loginItem.setOpenAtLogin(enabled);
  }),
});
