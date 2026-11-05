import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientPreferences from "../../settings/DesktopClientPreferences.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientPreferences.DesktopClientPreferences;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings) {
    const clientSettings = yield* DesktopClientPreferences.DesktopClientPreferences;
    const dialog = yield* ElectronDialog.ElectronDialog;
    yield* clientSettings
      .set(settings)
      .pipe(
        Effect.tapError((error) =>
          error._tag === "DesktopTrayError" || error._tag === "DesktopLoginItemError"
            ? dialog.showErrorBox("Desktop setting unavailable", error.message)
            : Effect.void,
        ),
      );
  }),
});
