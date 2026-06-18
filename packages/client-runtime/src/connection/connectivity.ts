import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

export class Connectivity extends Context.Service<
  Connectivity,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
  }
>()("@t3tools/client-runtime/connection/connectivity") {}
