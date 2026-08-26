import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const openScreenRecordingSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_SCREEN_RECORDING_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.screenshot.openScreenRecordingSettings")(function* () {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openScreenRecordingSettings;
  }),
});
