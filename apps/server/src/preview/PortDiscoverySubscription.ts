import type { DiscoveredLocalServerList } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as PortScanner from "./PortScanner.ts";

type PortDiscoverySubscription = Pick<PortScanner.PortDiscovery["Service"], "retain" | "subscribe">;

export const makeStream = (
  portDiscovery: PortDiscoverySubscription,
  configuredUrls: ReadonlyArray<string>,
): Stream.Stream<DiscoveredLocalServerList> =>
  Stream.callback<DiscoveredLocalServerList>((queue) =>
    Effect.gen(function* () {
      // Retention performs one immediate scan when discovery was idle or when
      // this connection introduces configured URLs. Subscription then replays
      // that snapshot instead of initiating a duplicate scan.
      yield* portDiscovery.retain(configuredUrls);
      yield* portDiscovery.subscribe({ configuredUrls }, (servers) =>
        Effect.gen(function* () {
          const scannedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Queue.offer(queue, {
            servers,
            scannedAt,
            configuredUrlProbing: true,
          });
        }),
      );
    }),
  );
