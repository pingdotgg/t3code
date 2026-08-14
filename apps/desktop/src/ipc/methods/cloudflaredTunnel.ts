import {
  DesktopCloudflaredTunnelInputSchema,
  DesktopCloudflaredTunnelStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCloudflaredTunnel from "../../backend/DesktopCloudflaredTunnel.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getCloudflaredTunnelState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLOUDFLARED_TUNNEL_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflaredTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflaredTunnel.getState")(function* () {
    const tunnel = yield* DesktopCloudflaredTunnel.DesktopCloudflaredTunnel;
    return yield* tunnel.getState;
  }),
});

export const setCloudflaredTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLOUDFLARED_TUNNEL_CHANNEL,
  payload: DesktopCloudflaredTunnelInputSchema,
  result: DesktopCloudflaredTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflaredTunnel.set")(function* (input) {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const tunnel = yield* DesktopCloudflaredTunnel.DesktopCloudflaredTunnel;
    const state = yield* tunnel.apply(input);
    const runtimeMatchesRequest =
      state.enabled === input.enabled && state.configPath === input.configPath;
    if (state.error === null || state.status !== "running" || runtimeMatchesRequest) {
      yield* settings.setCloudflaredTunnel(input);
    }
    return state;
  }),
});
