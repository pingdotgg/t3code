import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLegacyLocalStorage from "../../app/DesktopLegacyLocalStorage.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const takeLegacyLocalStorage = makeSyncIpcMethod({
  channel: IpcChannels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL,
  result: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  handler: Effect.fn("desktop.ipc.legacyLocalStorage.take")(function* () {
    const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
    return Option.getOrNull(yield* legacy.take);
  }),
});

export const completeLegacyLocalStorage = makeIpcMethod({
  channel: IpcChannels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.legacyLocalStorage.complete")(function* (_, event) {
    const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
    // Chromium writes localStorage to disk lazily; persist the merge before
    // the marker stops later launches from retrying it.
    if (event) Electron.webContents.fromId(event.sender.id)?.session.flushStorageData();
    yield* legacy.complete;
  }),
});
