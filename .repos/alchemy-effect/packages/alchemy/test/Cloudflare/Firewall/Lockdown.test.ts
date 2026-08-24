import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as firewall from "@distilled.cloud/cloudflare/firewall";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test URL patterns. A lockdown rule's URL set is its
// identity within a zone (duplicates are rejected), so each test owns
// disjoint paths and the same values are reused on every run (never
// Date.now()/random). Zone Lockdown quota on Pro is 3 rules — each test
// holds at most one rule at a time.
const URL_LIFECYCLE_V1 = `${zoneName}/alchemy-lockdown-lifecycle*`;
const URL_LIFECYCLE_V2 = `${zoneName}/alchemy-lockdown-lifecycle-v2*`;
const IP_V1 = "198.51.100.111";
const RANGE_V2 = "203.0.113.0/24";

const URL_LIST = `${zoneName}/alchemy-lockdown-list*`;
const IP_LIST = "198.51.100.222";

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

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union via patches) on the test's own
// out-of-band verification calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const getLockdown = (zoneId: string, lockdownId: string) =>
  firewall
    .getLockdown({ zoneId, lockDownsId: lockdownId })
    .pipe(Effect.retry(forbiddenRetry));

// List every lockdown whose URL set intersects the given urls — used both
// for assertions and to purge leftovers from interrupted runs so each test
// starts from a clean slate (a leaked rule would surface as
// Unowned/duplicate because the URL set is identity).
const listByUrls = (zoneId: string, urls: string[]) =>
  firewall.listLockdowns.items({ zoneId }).pipe(
    Stream.filter((r) => r.urls.some((u) => urls.includes(u))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry(forbiddenRetry),
  );

const purgeLockdowns = (zoneId: string, urls: string[]) =>
  listByUrls(zoneId, urls).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        firewall.deleteLockdown({ zoneId, lockDownsId: r.id }).pipe(
          Effect.retry(forbiddenRetry),
          Effect.catchTag("LockdownNotFound", () => Effect.void),
        ),
      ),
    ),
  );

// Poll until the rule is gone — a missing rule surfaces as the typed
// `LockdownNotFound` (Cloudflare code 10001, zonelockdown.api.not_found).
const expectLockdownGone = (zoneId: string, lockdownId: string) =>
  getLockdown(zoneId, lockdownId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "LockdownNotDeleted" } as const)),
    Effect.catchTag("LockdownNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LockdownNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update urls/configurations/description/paused in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeLockdowns(zoneId, [URL_LIFECYCLE_V1, URL_LIFECYCLE_V2]);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.Lockdown("LifecycleLockdown", {
            zoneId,
            urls: [URL_LIFECYCLE_V1],
            configurations: [{ target: "ip", value: IP_V1 }],
            description: "alchemy lockdown test (v1)",
          }).pipe(adopt(true));
        }),
      );

      expect(initial.lockdownId).toBeDefined();
      expect(initial.zoneId).toEqual(zoneId);
      expect(initial.urls).toEqual([URL_LIFECYCLE_V1]);
      expect(initial.configurations).toEqual([{ target: "ip", value: IP_V1 }]);
      expect(initial.description).toEqual("alchemy lockdown test (v1)");
      expect(initial.paused).toEqual(false);

      const live = yield* getLockdown(zoneId, initial.lockdownId);
      expect(live.id).toEqual(initial.lockdownId);
      expect(live.urls).toEqual([URL_LIFECYCLE_V1]);
      expect(live.configurations).toEqual([{ target: "ip", value: IP_V1 }]);

      // Update every mutable aspect in one PUT: add a second url, add an
      // ip_range allow entry, change the description, and pause the rule.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.Lockdown("LifecycleLockdown", {
            zoneId,
            urls: [URL_LIFECYCLE_V1, URL_LIFECYCLE_V2],
            configurations: [
              { target: "ip", value: IP_V1 },
              { target: "ip_range", value: RANGE_V2 },
            ],
            description: "alchemy lockdown test (v2)",
            paused: true,
          }).pipe(adopt(true));
        }),
      );

      // Same rule updated in place — not a replacement.
      expect(updated.lockdownId).toEqual(initial.lockdownId);
      expect([...updated.urls].sort()).toEqual(
        [URL_LIFECYCLE_V1, URL_LIFECYCLE_V2].sort(),
      );
      expect(updated.configurations).toHaveLength(2);
      expect(updated.description).toEqual("alchemy lockdown test (v2)");
      expect(updated.paused).toEqual(true);

      const liveUpdated = yield* getLockdown(zoneId, updated.lockdownId);
      expect([...liveUpdated.urls].sort()).toEqual(
        [URL_LIFECYCLE_V1, URL_LIFECYCLE_V2].sort(),
      );
      expect(liveUpdated.configurations).toHaveLength(2);
      expect(liveUpdated.description).toEqual("alchemy lockdown test (v2)");
      expect(liveUpdated.paused).toEqual(true);

      // Redeploying identical props is a no-op (still the same rule).
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.Lockdown("LifecycleLockdown", {
            zoneId,
            urls: [URL_LIFECYCLE_V1, URL_LIFECYCLE_V2],
            configurations: [
              { target: "ip", value: IP_V1 },
              { target: "ip_range", value: RANGE_V2 },
            ],
            description: "alchemy lockdown test (v2)",
            paused: true,
          }).pipe(adopt(true));
        }),
      );
      expect(noop.lockdownId).toEqual(initial.lockdownId);

      yield* stack.destroy();

      yield* expectLockdownGone(zoneId, initial.lockdownId);
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): `list()` fans out over
// every zone via `listAllZones`, exhaustively paginates each zone's lockdown
// rules, and hydrates them into the `read` Attributes shape. Deploy a rule and
// assert it appears in the enumerated result.
test.provider("list enumerates the deployed lockdown rule", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeLockdowns(zoneId, [URL_LIST]);

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.Lockdown("ListLockdown", {
          zoneId,
          urls: [URL_LIST],
          configurations: [{ target: "ip", value: IP_LIST }],
          description: "alchemy lockdown list test",
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Firewall.Lockdown);
    const all = yield* provider.list();

    expect(all.some((r) => r.lockdownId === deployed.lockdownId)).toBe(true);
    const found = all.find((r) => r.lockdownId === deployed.lockdownId);
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.urls).toEqual([URL_LIST]);

    yield* stack.destroy();

    yield* expectLockdownGone(zoneId, deployed.lockdownId);
  }).pipe(logLevel),
);
