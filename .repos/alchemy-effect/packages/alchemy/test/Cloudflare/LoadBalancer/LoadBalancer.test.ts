import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as loadBalancers from "@distilled.cloud/cloudflare/load-balancers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Load Balancing is a paid add-on subscription. The testing zone does not
// have it: load balancer creation is rejected with "load balancing not
// enabled for zone" (Cloudflare code 1002), surfaced as the typed
// `LoadBalancingNotEnabledForZone` error. Set CLOUDFLARE_LB_ENABLED=1 once
// the subscription is provisioned to run the full lifecycle test.
const lbEnabled = !!process.env.CLOUDFLARE_LB_ENABLED;

// Deterministic per-test hostnames — reused on every run.
const NAME_ENTITLEMENT = `alchemy-lb-entitlement-probe.${zoneName}`;
const NAME_LIFECYCLE = `alchemy-lb-lifecycle.${zoneName}`;
const NAME_POOL = "alchemy-lb-lifecycle-pool";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getLoadBalancer = (zoneId: string, loadBalancerId: string) =>
  loadBalancers.getLoadBalancer({ zoneId, loadBalancerId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const expectGone = (zoneId: string, loadBalancerId: string) =>
  getLoadBalancer(zoneId, loadBalancerId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "LoadBalancerNotDeleted" } as const),
    ),
    // A missing load balancer surfaces as the typed `LoadBalancerNotFound`
    // (Cloudflare error code 1001) — that's the success condition here.
    Effect.catchTag("LoadBalancerNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LoadBalancerNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Unentitlement probe: pins the typed plan-gate rejection, so it must skip
// on entitled accounts — there the create would succeed instead of failing.
test.provider.skipIf(lbEnabled)(
  "surfaces the typed LoadBalancingNotEnabledForZone error without the LB subscription",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The zone entitlement gate fires before pool validation, so
      // placeholder pool ids are fine here.
      const error = yield* loadBalancers
        .createLoadBalancer({
          zoneId,
          name: NAME_ENTITLEMENT,
          defaultPools: ["17b5962d775c646f3f9725cbc7a53df4"],
          fallbackPool: "17b5962d775c646f3f9725cbc7a53df4",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("LoadBalancingNotEnabledForZone");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!lbEnabled)(
  "create, update in place, and destroy a load balancer",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* Cloudflare.LoadBalancer.Pool("Pool", {
            name: NAME_POOL,
            origins: [{ name: "origin-1", address: "203.0.113.10" }],
          });
          const lb = yield* Cloudflare.LoadBalancer.LoadBalancer("Lb", {
            zoneId,
            name: NAME_LIFECYCLE,
            defaultPools: [pool.poolId],
            fallbackPool: pool.poolId,
            proxied: false,
            ttl: 30,
          });
          return { pool, lb };
        }),
      );

      expect(initial.lb.loadBalancerId).toBeTruthy();
      expect(initial.lb.zoneId).toEqual(zoneId);
      expect(initial.lb.name).toEqual(NAME_LIFECYCLE);
      expect(initial.lb.proxied).toEqual(false);
      expect(initial.lb.defaultPools).toEqual([initial.pool.poolId]);
      expect(initial.lb.fallbackPool).toEqual(initial.pool.poolId);

      const live = yield* getLoadBalancer(zoneId, initial.lb.loadBalancerId);
      expect(live.name).toEqual(NAME_LIFECYCLE);
      expect(live.defaultPools).toEqual([initial.pool.poolId]);

      // Mutable props (steering, affinity, proxied) update in place — same
      // loadBalancerId. Keep the pool deployed across every step so the
      // engine never has to replace and drop a dependency in one deploy.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* Cloudflare.LoadBalancer.Pool("Pool", {
            name: NAME_POOL,
            origins: [{ name: "origin-1", address: "203.0.113.10" }],
          });
          const lb = yield* Cloudflare.LoadBalancer.LoadBalancer("Lb", {
            zoneId,
            name: NAME_LIFECYCLE,
            defaultPools: [pool.poolId],
            fallbackPool: pool.poolId,
            proxied: true,
            steeringPolicy: "random",
            sessionAffinity: "cookie",
          });
          return { pool, lb };
        }),
      );
      expect(updated.lb.loadBalancerId).toEqual(initial.lb.loadBalancerId);
      expect(updated.lb.proxied).toEqual(true);
      expect(updated.lb.steeringPolicy).toEqual("random");

      const synced = yield* getLoadBalancer(zoneId, updated.lb.loadBalancerId);
      expect(synced.proxied).toEqual(true);
      expect(synced.steeringPolicy).toEqual("random");
      expect(synced.sessionAffinity).toEqual("cookie");

      yield* stack.destroy();

      yield* expectGone(zoneId, initial.lb.loadBalancerId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test, ungated read-only half: load balancers are
// zone-scoped, so `list()` fans out over every zone and exhaustively
// paginates each zone's load balancers. The testing account's zones lack
// the Load Balancing subscription, so the per-zone list yields no rows
// (and any `Forbidden` zone is skipped) — assert a well-typed array whose
// elements (if any) match the `read` Attributes shape.
test.provider(
  "list returns a well-typed array of load balancers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.LoadBalancer,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const lb of all) {
        expect(typeof lb.loadBalancerId).toBe("string");
        expect(typeof lb.zoneId).toBe("string");
        expect(typeof lb.name).toBe("string");
        expect(typeof lb.enabled).toBe("boolean");
        expect(typeof lb.proxied).toBe("boolean");
        expect(typeof lb.steeringPolicy).toBe("string");
        expect(Array.isArray(lb.defaultPools)).toBe(true);
        expect(typeof lb.fallbackPool).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Entitlement-gated half: with the Load Balancing subscription enabled,
// deploy a real pool + load balancer and assert the deployed item appears
// in the exhaustively-paginated, fanned-out `list()` result.
test.provider.skipIf(!lbEnabled)(
  "list enumerates the deployed load balancer",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* Cloudflare.LoadBalancer.Pool("Pool", {
            name: NAME_POOL,
            origins: [{ name: "origin-1", address: "203.0.113.10" }],
          });
          const lb = yield* Cloudflare.LoadBalancer.LoadBalancer("Lb", {
            zoneId,
            name: NAME_LIFECYCLE,
            defaultPools: [pool.poolId],
            fallbackPool: pool.poolId,
            proxied: false,
            ttl: 30,
          });
          return { pool, lb };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.LoadBalancer,
      );
      const all = yield* provider.list();

      const row = all.find(
        (lb) => lb.loadBalancerId === deployed.lb.loadBalancerId,
      );
      expect(row).toBeDefined();
      expect(row!.zoneId).toEqual(zoneId);
      expect(row!.name).toEqual(NAME_LIFECYCLE);

      yield* stack.destroy();

      yield* expectGone(zoneId, deployed.lb.loadBalancerId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
