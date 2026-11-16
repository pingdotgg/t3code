import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopWebLinks from "../../app/DesktopWebLinks.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WEB_LINK_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.webLinks.setReady")(function* (ready, event) {
    if (event === undefined) return;
    const window = yield* (yield* ElectronWindow.ElectronWindow).appWindowFor(event.sender);
    if (Option.isNone(window)) return;
    const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
    yield* webLinks.setRendererReady(ready, window.value);
  }),
});
