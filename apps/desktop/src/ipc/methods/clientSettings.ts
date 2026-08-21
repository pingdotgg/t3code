import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSpellcheck from "../../electron/ElectronSpellcheck.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const setClientSettingsSemaphore = Semaphore.makeUnsafe(1);

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings) {
    yield* setClientSettingsSemaphore.withPermit(
      Effect.gen(function* () {
        const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
        const previousSettings = yield* clientSettings.get;
        yield* clientSettings.set(settings);
        if (
          Option.isSome(previousSettings) &&
          ElectronSpellcheck.spellcheckSettingsEqual(previousSettings.value, settings)
        ) {
          return;
        }
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        const window = yield* electronWindow.currentMainOrFirst;
        if (Option.isSome(window)) {
          yield* ElectronSpellcheck.syncBrowserWindowSpellChecker(window.value, settings);
        }
      }),
    );
  }),
});
