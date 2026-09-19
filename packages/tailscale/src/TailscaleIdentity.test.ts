import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  TAILSCALE_IDENTITY_CACHE_TTL,
  TAILSCALE_IDENTITY_LOOKUP_TIMEOUT,
  TailscaleIdentityDiscovery,
  TailscaleIdentityNode,
  make,
  type TailscaleIdentityNodeService,
  type TailscaleNetworkInterfaces,
} from "./TailscaleIdentity.ts";

const discoverWithNode = <A, E>(
  networkInterfaces: Effect.Effect<TailscaleNetworkInterfaces>,
  reverseLookup: TailscaleIdentityNodeService["reverseLookup"],
  effect: Effect.Effect<A, E, TailscaleIdentityDiscovery>,
) =>
  effect.pipe(
    Effect.provideServiceEffect(
      TailscaleIdentityDiscovery,
      make.pipe(
        Effect.provideService(TailscaleIdentityNode, {
          networkInterfaces,
          reverseLookup,
        }),
      ),
    ),
  );

describe("TailscaleIdentityDiscovery", () => {
  it.effect("discovers stable, deduplicated ts.net names from Tailscale IPv4 addresses", () => {
    const lookedUpAddresses: string[] = [];
    return discoverWithNode(
      Effect.succeed({
        en0: [
          { address: "100.100.0.3", family: "IPv4", internal: false },
          { address: "100.100.0.2", family: "IPv4", internal: false },
          { address: "100.100.0.2", family: "IPv4", internal: false },
          { address: "100.100.0.4", family: 6, internal: false },
          { address: "100.63.0.1", family: "IPv4", internal: false },
          { address: "100.128.0.1", family: "IPv4", internal: false },
          { address: "100.100.0.5", family: "IPv4", internal: true },
        ],
      }),
      (address) => {
        lookedUpAddresses.push(address);
        return Effect.succeed(
          address === "100.100.0.2"
            ? ["Machine.Tail.Example.ts.net.", "machine.tail.example.ts.net"]
            : ["other.ts.net", "invalid.example.test"],
        );
      },
      Effect.gen(function* () {
        const service = yield* TailscaleIdentityDiscovery;
        assert.deepEqual(yield* service.discover, {
          dnsNames: ["machine.tail.example.ts.net", "other.ts.net"],
        });
        assert.deepEqual(lookedUpAddresses, ["100.100.0.2", "100.100.0.3"]);
      }),
    );
  });

  it.effect("does not reverse-resolve when no Tailscale address is present", () => {
    let reverseCalls = 0;
    return discoverWithNode(
      Effect.succeed({
        en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      }),
      () => {
        reverseCalls += 1;
        return Effect.succeed([] as readonly string[]);
      },
      Effect.gen(function* () {
        const service = yield* TailscaleIdentityDiscovery;
        assert.deepEqual(yield* service.discover, { dnsNames: [] });
        assert.deepEqual(yield* service.discover, { dnsNames: [] });
        assert.equal(reverseCalls, 0);
      }),
    );
  });

  it.effect("caches empty results and reuses them for the address set TTL", () => {
    let reverseCalls = 0;
    return discoverWithNode(
      Effect.succeed({
        tailscale0: [{ address: "100.100.0.2", family: "IPv4", internal: false }],
      }),
      () => {
        reverseCalls += 1;
        return Effect.succeed([] as readonly string[]);
      },
      Effect.gen(function* () {
        const service = yield* TailscaleIdentityDiscovery;
        assert.deepEqual(yield* service.discover, { dnsNames: [] });
        assert.deepEqual(yield* service.discover, { dnsNames: [] });
        assert.equal(reverseCalls, 1);

        yield* TestClock.adjust(TAILSCALE_IDENTITY_CACHE_TTL);
        yield* service.discover;
        assert.equal(reverseCalls, 2);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it.effect("invalidates the cached identity when the address set changes", () => {
    let currentInterfaces: TailscaleNetworkInterfaces = {
      tailscale0: [{ address: "100.100.0.2", family: "IPv4", internal: false }],
    };
    let reverseCalls = 0;
    return discoverWithNode(
      Effect.sync(() => currentInterfaces),
      (address) => {
        reverseCalls += 1;
        return Effect.succeed([`${address}.ts.net`]);
      },
      Effect.gen(function* () {
        const service = yield* TailscaleIdentityDiscovery;
        assert.deepEqual(yield* service.discover, {
          dnsNames: ["100.100.0.2.ts.net"],
        });

        currentInterfaces = {
          tailscale0: [{ address: "100.100.0.3", family: "IPv4", internal: false }],
        };
        assert.deepEqual(yield* service.discover, {
          dnsNames: ["100.100.0.3.ts.net"],
        });
        assert.equal(reverseCalls, 2);
      }),
    );
  });

  it.effect("shares concurrent lookups for the same address set", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reverseCalls = 0;
      const service = yield* discoverWithNode(
        Effect.succeed({
          tailscale0: [{ address: "100.100.0.2", family: "IPv4", internal: false }],
        }),
        () =>
          Effect.gen(function* () {
            reverseCalls += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return ["node.ts.net"];
          }),
        Effect.service(TailscaleIdentityDiscovery),
      );
      const firstFiber = yield* Effect.forkChild(service.discover);
      const secondFiber = yield* Effect.forkChild(service.discover);

      yield* Deferred.await(started);
      assert.equal(reverseCalls, 1);
      yield* Deferred.succeed(release, undefined);

      assert.deepEqual(yield* Fiber.join(firstFiber), { dnsNames: ["node.ts.net"] });
      assert.deepEqual(yield* Fiber.join(secondFiber), { dnsNames: ["node.ts.net"] });
    }),
  );

  it.effect("keeps a shared lookup alive when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reverseCalls = 0;
      const service = yield* discoverWithNode(
        Effect.succeed({
          tailscale0: [{ address: "100.100.0.2", family: "IPv4", internal: false }],
        }),
        () =>
          Effect.gen(function* () {
            reverseCalls += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return ["node.ts.net"];
          }),
        Effect.service(TailscaleIdentityDiscovery),
      );
      const interruptedCaller = yield* Effect.forkChild(service.discover);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(interruptedCaller);
      yield* Deferred.succeed(release, undefined);

      assert.deepEqual(yield* service.discover, { dnsNames: ["node.ts.net"] });
      assert.equal(reverseCalls, 1);
    }),
  );

  it.effect("degrades a timed-out total lookup to an empty identity", () =>
    Effect.gen(function* () {
      const service = yield* TailscaleIdentityDiscovery;
      const fiber = yield* Effect.forkChild(service.discover);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_IDENTITY_LOOKUP_TIMEOUT);
      assert.deepEqual(yield* Fiber.join(fiber), { dnsNames: [] });
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideServiceEffect(
        TailscaleIdentityDiscovery,
        make.pipe(
          Effect.provideService(TailscaleIdentityNode, {
            networkInterfaces: Effect.succeed({
              tailscale0: [{ address: "100.100.0.2", family: "IPv4", internal: false }],
            }),
            reverseLookup: () => Effect.never,
          }),
        ),
      ),
    ),
  );
});
