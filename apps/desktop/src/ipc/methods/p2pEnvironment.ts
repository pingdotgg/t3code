import {
  DesktopP2pEnvironmentDialInputSchema,
  DesktopP2pEnvironmentDisconnectInputSchema,
  DesktopP2pEnvironmentEndpointSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopP2pEnvironment from "../../p2p/DesktopP2pEnvironment.ts";

export const ensureP2pEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_P2P_ENVIRONMENT_CHANNEL,
  payload: DesktopP2pEnvironmentDialInputSchema,
  result: DesktopP2pEnvironmentEndpointSchema,
  handler: Effect.fn("desktop.ipc.p2pEnvironment.ensureEnvironment")(function* (input) {
    const p2pEnvironment = yield* DesktopP2pEnvironment.DesktopP2pEnvironment;
    return yield* p2pEnvironment.ensureEnvironment(input);
  }),
});

export const disconnectP2pEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_P2P_ENVIRONMENT_CHANNEL,
  payload: DesktopP2pEnvironmentDisconnectInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.p2pEnvironment.disconnectEnvironment")(function* ({
    publicKeyZ32,
  }) {
    const p2pEnvironment = yield* DesktopP2pEnvironment.DesktopP2pEnvironment;
    yield* p2pEnvironment.disconnectEnvironment(publicKeyZ32);
  }),
});
