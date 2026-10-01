import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  TAILSCALE_IDENTITY_CACHE_TTL,
  TAILSCALE_IDENTITY_LOOKUP_TIMEOUT,
  TailscaleIdentityNode,
  make,
  type TailscaleIdentityNodeService,
  type TailscaleNetworkInterfaces,
} from "./TailscaleIdentity.ts";

const tailscaleInterface = (ipv4: string): TailscaleNetworkInterfaces => ({
  utun4: [
    { address: "fe80::1", family: "IPv6" },
    { address: ipv4, family: "IPv4" },
    { address: "fd7a:115c:a1e0::3a01:437d", family: "IPv6" },
  ],
});

const makeDiscovery = (
  networkInterfaces: Effect.Effect<TailscaleNetworkInterfaces>,
  reverseLookup: TailscaleIdentityNodeService["reverseLookup"],
) => make.pipe(Effect.provideService(TailscaleIdentityNode, { networkInterfaces, reverseLookup }));

/** A reverse lookup that blocks until released, for observing shared lookups */
const makeBlockingLookup = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls = { count: 0 };
  const reverseLookup = () =>
    Effect.gen(function* () {
      calls.count += 1;
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      return "node.tail.ts.net";
    });

  return { started, release, calls, reverseLookup };
});

describe("TailscaleIdentityDiscovery", () => {
  it.effect("resolves custom control-server names on a Tailscale-owned interface", () => {
    const lookedUpAddresses: string[] = [];
    return Effect.gen(function* () {
      const discovery = yield* makeDiscovery(
        Effect.succeed({
          // carrier-grade NAT shares 100.64.0.0/10, so this one is ignored
          en0: [{ address: "100.64.0.9", family: "IPv4" }],
          ...tailscaleInterface("100.100.0.3"),
          tailscale0: [
            { address: "100.100.0.2", family: 4 },
            { address: "FD7A:115C:A1E0::2", family: 6 },
          ],
        }),
        (address) => {
          lookedUpAddresses.push(address);
          return Effect.succeed("Machine.Headscale.Example.com.");
        },
      );

      assert.equal(yield* discovery.magicDnsName, "machine.headscale.example.com");
      assert.deepEqual(lookedUpAddresses, ["100.100.0.2"]);
    });
  });

  it.effect("does not reverse-resolve without a Tailscale-owned interface", () => {
    let reverseCalls = 0;
    return Effect.gen(function* () {
      const discovery = yield* makeDiscovery(
        Effect.succeed({
          en0: [
            { address: "100.64.0.9", family: "IPv4" },
            { address: "fd00::9", family: "IPv6" },
          ],
        }),
        () => {
          reverseCalls += 1;
          return Effect.succeed("unexpected.example.com");
        },
      );

      assert.isNull(yield* discovery.magicDnsName);
      assert.equal(reverseCalls, 0);
    });
  });

  it.effect("rejects an echoed address or a single-label name", () =>
    Effect.gen(function* () {
      for (const hostname of ["100.100.0.2", "machine", ""]) {
        const discovery = yield* makeDiscovery(
          Effect.succeed(tailscaleInterface("100.100.0.2")),
          () => Effect.succeed(hostname),
        );
        assert.isNull(yield* discovery.magicDnsName);
      }
    }),
  );

  it.effect("caches missing names for the TTL and refreshes on an address change", () => {
    let currentInterfaces = tailscaleInterface("100.100.0.2");
    let reverseCalls = 0;
    return Effect.gen(function* () {
      const discovery = yield* makeDiscovery(
        Effect.sync(() => currentInterfaces),
        () => {
          reverseCalls += 1;
          return Effect.succeed(null);
        },
      );

      assert.isNull(yield* discovery.magicDnsName);
      assert.isNull(yield* discovery.magicDnsName);
      assert.equal(reverseCalls, 1);

      yield* TestClock.adjust(TAILSCALE_IDENTITY_CACHE_TTL);
      yield* discovery.magicDnsName;
      assert.equal(reverseCalls, 2);

      currentInterfaces = tailscaleInterface("100.100.0.3");
      yield* discovery.magicDnsName;
      assert.equal(reverseCalls, 3);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("shares one lookup when a concurrent caller is interrupted", () =>
    Effect.gen(function* () {
      const lookup = yield* makeBlockingLookup;
      const discovery = yield* makeDiscovery(
        Effect.succeed(tailscaleInterface("100.100.0.2")),
        lookup.reverseLookup,
      );
      const interruptedCaller = yield* Effect.forkChild(discovery.magicDnsName);
      const waitingCaller = yield* Effect.forkChild(discovery.magicDnsName);

      yield* Deferred.await(lookup.started);
      yield* Fiber.interrupt(interruptedCaller);
      yield* Deferred.succeed(lookup.release, undefined);

      assert.equal(yield* Fiber.join(waitingCaller), "node.tail.ts.net");
      assert.equal(lookup.calls.count, 1);
    }),
  );

  it.effect("does not cache a lookup that every caller abandoned", () =>
    Effect.gen(function* () {
      const lookup = yield* makeBlockingLookup;
      const discovery = yield* makeDiscovery(
        Effect.succeed(tailscaleInterface("100.100.0.2")),
        lookup.reverseLookup,
      );
      const abandonedCaller = yield* Effect.forkChild(discovery.magicDnsName);

      yield* Deferred.await(lookup.started);
      yield* Fiber.interrupt(abandonedCaller);
      yield* Deferred.succeed(lookup.release, undefined);

      assert.equal(yield* discovery.magicDnsName, "node.tail.ts.net");
    }),
  );

  it.effect("degrades a timed-out lookup to no name", () =>
    Effect.gen(function* () {
      const discovery = yield* makeDiscovery(
        Effect.succeed(tailscaleInterface("100.100.0.2")),
        () => Effect.never,
      );
      const fiber = yield* Effect.forkChild(discovery.magicDnsName);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_IDENTITY_LOOKUP_TIMEOUT);
      assert.isNull(yield* Fiber.join(fiber));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
