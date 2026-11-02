import { LanDiscoveryService } from "@t3tools/contracts";
import { browseLanServices, type LanService } from "@t3tools/shared/nodeLanDiscovery";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const scanLanServices = Effect.fn("desktop.ipc.scanLanServices")(function* (
  browse: typeof browseLanServices = browseLanServices,
) {
  let services: ReadonlyArray<LanService> = [];
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        browse((next) => {
          services = next.slice(0, 128);
        }),
      catch: () => undefined,
    }),
    () => Effect.sleep("1500 millis").pipe(Effect.andThen(Effect.sync(() => services))),
    (browser) => Effect.sync(browser.stop),
  ).pipe(Effect.orElseSucceed(() => []));
});

export const discoverLanServices = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_LAN_SERVICES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(LanDiscoveryService),
  handler: () => scanLanServices(),
});
