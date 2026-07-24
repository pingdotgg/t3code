import { LocalServerAdvertisement } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLocalServerDiscovery from "../../app/DesktopLocalServerDiscovery.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const discoverLocalServers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_LOCAL_SERVERS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(LocalServerAdvertisement),
  handler: Effect.fn("desktop.ipc.localServerDiscovery.discover")(function* () {
    const discovery = yield* DesktopLocalServerDiscovery.DesktopLocalServerDiscovery;
    return yield* discovery.discover;
  }),
});
