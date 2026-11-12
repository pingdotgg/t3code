import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSpellcheck from "../../settings/DesktopSpellcheck.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

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
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    const spellcheck = yield* DesktopSpellcheck.DesktopSpellcheck;
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    yield* spellcheck.configure(settings);
  }),
});

export const getSpellcheckLanguages = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_SPELLCHECK_LANGUAGES_CHANNEL,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.clientSettings.getSpellcheckLanguages")(function* () {
    const spellcheck = yield* DesktopSpellcheck.DesktopSpellcheck;
    return yield* spellcheck.availableLanguages;
  }),
});
