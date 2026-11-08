import { DesktopQuickComposerLaunch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopQuickComposer from "../../window/DesktopQuickComposer.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const hide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_HIDE_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.hide")(function* (_input, event) {
    if (event === undefined) return;
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).hide(event.sender.id);
  }),
});

export const submit = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_SUBMIT_CHANNEL,
  payload: DesktopQuickComposerLaunch,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.submit")(function* (launch, event) {
    if (event === undefined) return;
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).submit(event.sender.id, launch);
  }),
});
