import { DesktopOpenAtLoginStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLoginItem from "../../settings/DesktopLoginItem.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getOpenAtLoginState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_OPEN_AT_LOGIN_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopOpenAtLoginStateSchema,
  handler: Effect.fn("desktop.ipc.openAtLogin.getState")(function* () {
    return yield* DesktopLoginItem.readOpenAtLoginState();
  }),
});

export const setOpenAtLogin = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopOpenAtLoginStateSchema,
  handler: Effect.fn("desktop.ipc.openAtLogin.set")(function* (enabled) {
    return yield* DesktopLoginItem.setOpenAtLogin(enabled);
  }),
});
