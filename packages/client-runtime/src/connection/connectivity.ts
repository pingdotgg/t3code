import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

export class Connectivity extends Context.Service<
  Connectivity,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
    /**
     * False on cellular and similar paths where RFC1918 LAN addresses cannot
     * be reached. Defaults to true when the platform cannot tell.
     */
    readonly privateNetworkLikely: Effect.Effect<boolean>;
  }
>()("@t3tools/client-runtime/connection/connectivity") {}

const make = (service: Connectivity["Service"]) => Connectivity.of(service);

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, make(service));
