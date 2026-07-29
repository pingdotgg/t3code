import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
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

// Load Balancing is a paid add-on subscription. The testing account does
// not have it: pool creation is rejected with "Internal error creating or
// modifying pool. Access Failed." (Cloudflare code 1002), surfaced as the
// typed `PoolAccessFailed` error. Set CLOUDFLARE_LB_ENABLED=1 once the
// subscription is provisioned to run the full lifecycle tests.
const lbEnabled = !!process.env.CLOUDFLARE_LB_ENABLED;

// Deterministic per-test physical names — reused on every run.
const NAME_ENTITLEMENT = "alchemy-lb-pool-entitlement-probe";
const NAME_LIFECYCLE = "alchemy-lb-pool-lifecycle";
const NAME_MONITOR = "alchemy-lb-pool-lifecycle-monitor";

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getPool = (accountId: string, poolId: string) =>
  loadBalancers.getPool({ accountId, poolId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const expectGone = (accountId: string, poolId: string) =>
  getPool(accountId, poolId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "PoolNotDeleted" } as const)),
    // A missing pool surfaces as the typed `PoolNotFound` (Cloudflare error
    // code 1001) — that's the success condition here.
    Effect.catchTag("PoolNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PoolNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Unentitlement probe: pins the typed plan-gate rejection, so it must skip
// on entitled accounts — there the create would succeed instead of failing.
test.provider.skipIf(lbEnabled)(
  "surfaces the typed PoolAccessFailed error without the LB subscription",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const error = yield* loadBalancers
        .createPool({
          accountId,
          name: NAME_ENTITLEMENT,
          origins: [{ name: "origin-1", address: "203.0.113.10" }],
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("PoolAccessFailed");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!lbEnabled)(
  "create, update in place, and destroy a health-checked pool",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* Cloudflare.LoadBalancer.Monitor("Monitor", {
            description: NAME_MONITOR,
            type: "https",
            path: "/health",
            expectedCodes: "2xx",
          });
          const pool = yield* Cloudflare.LoadBalancer.Pool("Pool", {
            name: NAME_LIFECYCLE,
            origins: [{ name: "origin-1", address: "203.0.113.10" }],
            monitor: monitor.monitorId,
            description: "v1",
          });
          return { monitor, pool };
        }),
      );

      expect(initial.pool.poolId).toBeTruthy();
      expect(initial.pool.accountId).toEqual(accountId);
      expect(initial.pool.name).toEqual(NAME_LIFECYCLE);
      expect(initial.pool.monitor).toEqual(initial.monitor.monitorId);

      const live = yield* getPool(accountId, initial.pool.poolId);
      expect(live.name).toEqual(NAME_LIFECYCLE);
      expect(live.description).toEqual("v1");
      expect((live.origins ?? []).map((o) => o.address)).toEqual([
        "203.0.113.10",
      ]);

      // Mutable props (origins, weights, description) update in place —
      // same poolId. Keep the monitor deployed across every step so the
      // engine never has to replace and drop a dependency in one deploy.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* Cloudflare.LoadBalancer.Monitor("Monitor", {
            description: NAME_MONITOR,
            type: "https",
            path: "/health",
            expectedCodes: "2xx",
          });
          const pool = yield* Cloudflare.LoadBalancer.Pool("Pool", {
            name: NAME_LIFECYCLE,
            origins: [
              { name: "origin-1", address: "203.0.113.10", weight: 0.7 },
              { name: "origin-2", address: "203.0.113.11", weight: 0.3 },
            ],
            monitor: monitor.monitorId,
            description: "v2",
          });
          return { monitor, pool };
        }),
      );
      expect(updated.pool.poolId).toEqual(initial.pool.poolId);

      const synced = yield* getPool(accountId, updated.pool.poolId);
      expect(synced.description).toEqual("v2");
      expect((synced.origins ?? []).map((o) => o.address).sort()).toEqual([
        "203.0.113.10",
        "203.0.113.11",
      ]);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.pool.poolId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Account-collection list: enumerate every pool in the account and assert
// the deployed one is present. Gated like the lifecycle test — without the
// LB subscription, the deploy fails with the typed `PoolAccessFailed`.
test.provider.skipIf(!lbEnabled)(
  "list enumerates the deployed pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.LoadBalancer.Pool("ListPool", {
            name: NAME_LIFECYCLE,
            origins: [{ name: "origin-1", address: "203.0.113.10" }],
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.Pool,
      );
      const all = yield* provider.list();

      expect(all.some((p) => p.poolId === deployed.poolId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
