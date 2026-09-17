import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPairingLink from "../../app/DesktopPairingLink.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PAIRING_LINK_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pairingLink.setReady")(function* (ready) {
    const pairingLink = yield* DesktopPairingLink.DesktopPairingLink;
    yield* pairingLink.setRendererReady(ready);
  }),
});
