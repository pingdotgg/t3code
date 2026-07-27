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

// Monitor groups are Enterprise-only. On the testing account creation is
// rejected with "monitor groups not enabled; enterprise only" (Cloudflare
// code 1002), surfaced as the typed `MonitorGroupsNotEnabled` error. Set
// CLOUDFLARE_LB_MONITOR_GROUPS_ENABLED=1 on an Enterprise account (which
// also implies the Load Balancing subscription) to run the lifecycle test.
const monitorGroupsEnabled = !!process.env.CLOUDFLARE_LB_MONITOR_GROUPS_ENABLED;

// Deterministic per-test physical names — reused on every run.
const NAME_ENTITLEMENT = "alchemy-lb-monitorgroup-entitlement-probe";
const NAME_LIFECYCLE = "alchemy-lb-monitorgroup-lifecycle";
const NAME_MONITOR = "alchemy-lb-monitorgroup-lifecycle-monitor";

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getMonitorGroup = (accountId: string, monitorGroupId: string) =>
  loadBalancers.getMonitorGroup({ accountId, monitorGroupId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const expectGone = (accountId: string, monitorGroupId: string) =>
  getMonitorGroup(accountId, monitorGroupId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "MonitorGroupNotDeleted" } as const),
    ),
    // A missing group surfaces as the typed `MonitorGroupNotFound`
    // (Cloudflare error code 1001) — that's the success condition here.
    Effect.catchTag("MonitorGroupNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "MonitorGroupNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Unentitlement probe: pins the typed plan-gate rejection, so it must skip
// on Enterprise accounts — there the create would succeed instead of failing.
test.provider.skipIf(monitorGroupsEnabled)(
  "surfaces the typed MonitorGroupsNotEnabled error on non-Enterprise accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The entitlement gate fires before member validation, so a
      // placeholder monitor id is fine here.
      const error = yield* loadBalancers
        .createMonitorGroup({
          accountId,
          description: NAME_ENTITLEMENT,
          members: [
            {
              monitorId: "17b5962d775c646f3f9725cbc7a53df4",
              enabled: true,
              monitoringOnly: false,
              mustBeHealthy: true,
            },
          ],
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("MonitorGroupsNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Ungated probe: monitor group enumeration is account-scoped and works
// regardless of the Enterprise entitlement — a non-entitled account simply
// has no groups, so `list()` returns an array (typically empty here).
test.provider("list returns an array of monitor groups", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(
      Cloudflare.LoadBalancer.MonitorGroup,
    );
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);
  }).pipe(logLevel),
);

test.provider.skipIf(!monitorGroupsEnabled)(
  "list enumerates the deployed monitor group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* Cloudflare.LoadBalancer.Monitor("Monitor", {
            description: NAME_MONITOR,
            type: "https",
            path: "/health",
            expectedCodes: "2xx",
          });
          const group = yield* Cloudflare.LoadBalancer.MonitorGroup("Group", {
            description: NAME_LIFECYCLE,
            members: [{ monitorId: monitor.monitorId }],
          });
          return { monitor, group };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.MonitorGroup,
      );
      const all = yield* provider.list();
      expect(
        all.some((g) => g.monitorGroupId === deployed.group.monitorGroupId),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!monitorGroupsEnabled)(
  "create, update in place, and destroy a monitor group",
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
          const group = yield* Cloudflare.LoadBalancer.MonitorGroup("Group", {
            description: NAME_LIFECYCLE,
            members: [{ monitorId: monitor.monitorId }],
          });
          return { monitor, group };
        }),
      );

      expect(initial.group.monitorGroupId).toBeTruthy();
      expect(initial.group.accountId).toEqual(accountId);
      expect(initial.group.description).toEqual(NAME_LIFECYCLE);

      const live = yield* getMonitorGroup(
        accountId,
        initial.group.monitorGroupId,
      );
      expect(live.description).toEqual(NAME_LIFECYCLE);
      expect(live.members.map((m) => m.monitorId)).toEqual([
        initial.monitor.monitorId,
      ]);

      // Member flags update in place — same monitorGroupId. Keep the
      // monitor deployed across every step.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* Cloudflare.LoadBalancer.Monitor("Monitor", {
            description: NAME_MONITOR,
            type: "https",
            path: "/health",
            expectedCodes: "2xx",
          });
          const group = yield* Cloudflare.LoadBalancer.MonitorGroup("Group", {
            description: NAME_LIFECYCLE,
            members: [{ monitorId: monitor.monitorId, monitoringOnly: true }],
          });
          return { monitor, group };
        }),
      );
      expect(updated.group.monitorGroupId).toEqual(
        initial.group.monitorGroupId,
      );

      const synced = yield* getMonitorGroup(
        accountId,
        updated.group.monitorGroupId,
      );
      expect(synced.members[0]?.monitoringOnly).toEqual(true);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.group.monitorGroupId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
