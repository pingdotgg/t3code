import { it as effectIt } from "@effect/vitest";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import type * as PortScanner from "./PortScanner.ts";
import * as PortDiscoverySubscription from "./PortDiscoverySubscription.ts";

effectIt.effect("retains configured URLs before replaying the discovered-server snapshot", () =>
  Effect.gen(function* () {
    const configuredUrls = ["http://localhost:3000/"];
    const events: Array<string> = [];
    const discoveredServer = {
      host: "localhost",
      port: 3000,
      url: "http://localhost:3000/",
      processName: "node",
      pid: 123,
      terminal: null,
    } satisfies DiscoveredLocalServer;
    const portDiscovery: Pick<PortScanner.PortDiscovery["Service"], "retain" | "subscribe"> = {
      retain: (retainedUrls = []) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push(`retain:${retainedUrls.join(",")}`);
          }),
          () => Effect.sync(() => events.push("release")),
        ),
      subscribe: (input, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push(`subscribe:${input.configuredUrls.join(",")}`);
          }).pipe(Effect.andThen(listener([discoveredServer]))),
          () => Effect.sync(() => events.push("unsubscribe")),
        ),
    };

    yield* TestClock.setTime(0);
    const snapshots = yield* PortDiscoverySubscription.makeStream(
      portDiscovery,
      configuredUrls,
    ).pipe(Stream.take(1), Stream.runCollect, Effect.scoped);

    expect([...snapshots]).toEqual([
      {
        servers: [discoveredServer],
        scannedAt: "1970-01-01T00:00:00.000Z",
        configuredUrlProbing: true,
      },
    ]);
    expect(events).toEqual([
      "retain:http://localhost:3000/",
      "subscribe:http://localhost:3000/",
      "unsubscribe",
      "release",
    ]);
  }),
);
