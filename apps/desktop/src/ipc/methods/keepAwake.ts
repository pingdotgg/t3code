import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopKeepAwake from "../../power/DesktopKeepAwake.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SetKeepAwakeEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
});

export const getKeepAwakeState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_KEEP_AWAKE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopKeepAwake.DesktopKeepAwakeStateSchema,
  handler: Effect.fn("desktop.ipc.keepAwake.getState")(function* () {
    const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
    return yield* keepAwake.getState;
  }),
});

export const setKeepAwakeEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_KEEP_AWAKE_ENABLED_CHANNEL,
  payload: SetKeepAwakeEnabledInput,
  result: DesktopKeepAwake.DesktopKeepAwakeStateSchema,
  handler: Effect.fn("desktop.ipc.keepAwake.setEnabled")(function* (input) {
    const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
    return yield* keepAwake.setEnabled(input.enabled);
  }),
});
