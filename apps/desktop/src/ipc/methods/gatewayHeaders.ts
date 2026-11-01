import {
  DesktopGatewayHeadersEntrySchema,
  DesktopGatewayHeadersInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopGatewayHeaders from "../../app/DesktopGatewayHeaders.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const GatewayHeadersEntries = Schema.Array(DesktopGatewayHeadersEntrySchema);

export const getGatewayHeaders = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_GATEWAY_HEADERS_CHANNEL,
  payload: Schema.Void,
  result: GatewayHeadersEntries,
  handler: Effect.fn("desktop.ipc.gatewayHeaders.get")(function* () {
    const gatewayHeaders = yield* DesktopGatewayHeaders.DesktopGatewayHeaders;
    return yield* gatewayHeaders.list;
  }),
});

export const setGatewayHeaders = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_GATEWAY_HEADERS_CHANNEL,
  payload: DesktopGatewayHeadersInputSchema,
  result: GatewayHeadersEntries,
  handler: Effect.fn("desktop.ipc.gatewayHeaders.set")(function* (input) {
    const gatewayHeaders = yield* DesktopGatewayHeaders.DesktopGatewayHeaders;
    return yield* gatewayHeaders.set(input);
  }),
});

export const removeGatewayHeaders = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOVE_GATEWAY_HEADERS_CHANNEL,
  payload: Schema.String,
  result: GatewayHeadersEntries,
  handler: Effect.fn("desktop.ipc.gatewayHeaders.remove")(function* (origin) {
    const gatewayHeaders = yield* DesktopGatewayHeaders.DesktopGatewayHeaders;
    return yield* gatewayHeaders.remove(origin);
  }),
});
