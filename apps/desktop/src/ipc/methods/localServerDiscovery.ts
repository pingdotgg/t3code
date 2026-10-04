import { EnvironmentId, LocalServerPairingResult, RunningLocalServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopRunningLocalServers from "../../app/DesktopRunningLocalServers.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const discoverLocalServers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_LOCAL_SERVERS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(RunningLocalServer),
  handler: Effect.fn("desktop.ipc.localServerDiscovery.discover")(function* () {
    const discovery = yield* DesktopRunningLocalServers.DesktopRunningLocalServers;
    return yield* discovery.discover;
  }),
});

export const pairLocalServer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PAIR_LOCAL_SERVER_CHANNEL,
  payload: EnvironmentId,
  result: LocalServerPairingResult,
  handler: Effect.fn("desktop.ipc.localServerDiscovery.pair")(function* (environmentId) {
    const discovery = yield* DesktopRunningLocalServers.DesktopRunningLocalServers;
    return yield* discovery.pairLocalServer(environmentId);
  }),
});
