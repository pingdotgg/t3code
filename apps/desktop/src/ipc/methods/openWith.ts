import {
  DesktopApplicationSelection,
  DesktopOpenWithInput,
  OpenWithEntryPresentation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopOpenWith from "../../shell/DesktopOpenWith.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const pickOpenWithApplication = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_OPEN_WITH_APPLICATION_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopApplicationSelection),
  handler: Effect.fn("desktop.ipc.openWith.pickApplication")(function* () {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return Option.getOrNull(
      yield* dialog.pickApplication({ owner: yield* electronWindow.focusedMainOrFirst }),
    );
  }),
});

export const resolveOpenWithPresentations = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_OPEN_WITH_PRESENTATIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(OpenWithEntryPresentation),
  handler: Effect.fn("desktop.ipc.openWith.resolvePresentations")(function* () {
    const openWith = yield* DesktopOpenWith.DesktopOpenWith;
    return yield* openWith.resolvePresentations;
  }),
});

export const openWith = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_WITH_CHANNEL,
  payload: DesktopOpenWithInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.openWith.open")(function* (input) {
    const openWith = yield* DesktopOpenWith.DesktopOpenWith;
    yield* openWith.open(input);
  }),
});
