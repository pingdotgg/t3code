import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLegacyLocalStorage from "../../app/DesktopLegacyLocalStorage.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { type DesktopIpcInvokeEvent, makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

// One migration per profile: only the primary window takes and completes it.
const isPrimarySender = Effect.fnUntraced(function* (event: DesktopIpcInvokeEvent | undefined) {
  const primary = yield* (yield* ElectronWindow.ElectronWindow).primary;
  return (
    event !== undefined &&
    Option.isSome(primary) &&
    primary.value.webContents.id === event.sender.id
  );
});

export const takeLegacyLocalStorage = makeSyncIpcMethod({
  channel: IpcChannels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL,
  result: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  handler: Effect.fn("desktop.ipc.legacyLocalStorage.take")(function* (event) {
    if (!(yield* isPrimarySender(event))) return null;
    const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
    return Option.getOrNull(yield* legacy.take);
  }),
});

export const completeLegacyLocalStorage = makeIpcMethod({
  channel: IpcChannels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.legacyLocalStorage.complete")(function* (_, event) {
    if (!(yield* isPrimarySender(event))) return;
    const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
    // Flush Chromium's lazy writes before the marker prevents migration retries.
    if (event) Electron.webContents.fromId(event.sender.id)?.session.flushStorageData();
    yield* legacy.complete;
  }),
});
