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
// not have it: monitor creation is rejected with the degenerate plan limit
// "interval is not in range [1, 1]" (Cloudflare code 1002), surfaced as the
// typed `MonitorIntervalOutOfRange` error. Set CLOUDFLARE_LB_ENABLED=1 once
// the subscription is provisioned to run the full lifecycle tests.
const lbEnabled = !!process.env.CLOUDFLARE_LB_ENABLED;

// Deterministic per-test physical names — reused on every run.
const NAME_ENTITLEMENT = "alchemy-lb-monitor-entitlement-probe";
const NAME_LIFECYCLE = "alchemy-lb-monitor-lifecycle";

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getMonitor = (accountId: string, monitorId: string) =>
  loadBalancers.getMonitor({ accountId, monitorId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const expectGone = (accountId: string, monitorId: string) =>
  getMonitor(accountId, monitorId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "MonitorNotDeleted" } as const)),
    // A missing monitor surfaces as the typed `MonitorNotFound` (Cloudflare
    // error code 1001) — that's the success condition here.
    Effect.catchTag("MonitorNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "MonitorNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Unentitlement probe: pins the typed plan-gate rejection, so it must skip
// on entitled accounts — there the create would succeed instead of failing.
test.provider.skipIf(lbEnabled)(
  "surfaces the typed MonitorIntervalOutOfRange error without the LB subscription",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Without the Load Balancing subscription the account's allowed
      // monitor interval range collapses to [1, 1], so any realistic
      // interval is rejected with the typed plan-gate tag.
      const error = yield* loadBalancers
        .createMonitor({
          accountId,
          type: "http",
          description: NAME_ENTITLEMENT,
          interval: 60,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("MonitorIntervalOutOfRange");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!lbEnabled)(
  "create, update in place, and destroy a monitor",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.LoadBalancer.Monitor("Monitor", {
          description: NAME_LIFECYCLE,
          type: "https",
          path: "/health",
          expectedCodes: "2xx",
          allowInsecure: true,
        }),
      );

      expect(initial.monitorId).toBeTruthy();
      expect(initial.accountId).toEqual(accountId);
      expect(initial.description).toEqual(NAME_LIFECYCLE);
      expect(initial.type).toEqual("https");

      const live = yield* getMonitor(accountId, initial.monitorId);
      expect(live.description).toEqual(NAME_LIFECYCLE);
      expect(live.path).toEqual("/health");
      expect(live.expectedCodes).toEqual("2xx");

      // Mutable props update in place — same monitorId.
      const updated = yield* stack.deploy(
        Cloudflare.LoadBalancer.Monitor("Monitor", {
          description: NAME_LIFECYCLE,
          type: "https",
          path: "/healthz",
          expectedCodes: "200",
          allowInsecure: true,
          retries: 1,
        }),
      );
      expect(updated.monitorId).toEqual(initial.monitorId);

      const synced = yield* getMonitor(accountId, updated.monitorId);
      expect(synced.path).toEqual("/healthz");
      expect(synced.expectedCodes).toEqual("200");
      expect(synced.retries).toEqual(1);

      // Redeploying identical props is a no-op (still the same monitor).
      const noop = yield* stack.deploy(
        Cloudflare.LoadBalancer.Monitor("Monitor", {
          description: NAME_LIFECYCLE,
          type: "https",
          path: "/healthz",
          expectedCodes: "200",
          allowInsecure: true,
          retries: 1,
        }),
      );
      expect(noop.monitorId).toEqual(initial.monitorId);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.monitorId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Ungated: the account-scoped listMonitors enumeration works regardless of
// the Load Balancing subscription (it just returns an empty array on an
// unentitled account), so this proves the list() op end-to-end live.
test.provider(
  "list returns an array of monitor attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.Monitor,
      );
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      for (const monitor of all) {
        expect(typeof monitor.monitorId).toBe("string");
        expect(typeof monitor.accountId).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

// Full presence check — requires the LB subscription to deploy a real
// monitor. Skips on unentitled accounts (create fails with the typed
// MonitorIntervalOutOfRange plan-gate error). Set CLOUDFLARE_LB_ENABLED=1
// once the subscription is provisioned.
test.provider.skipIf(!lbEnabled)(
  "list enumerates the deployed monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.LoadBalancer.Monitor("ListMonitor", {
          description: NAME_LIFECYCLE,
          type: "https",
          path: "/health",
          expectedCodes: "2xx",
          allowInsecure: true,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.Monitor,
      );
      const all = yield* provider.list();

      expect(all.some((m) => m.monitorId === deployed.monitorId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
