import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPairingLink from "../../app/DesktopPairingLink.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const takePending = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TAKE_PAIRING_LINKS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.pairingLink.takePending")(function* () {
    const pairingLink = yield* DesktopPairingLink.DesktopPairingLink;
    return yield* pairingLink.takePending;
  }),
});
