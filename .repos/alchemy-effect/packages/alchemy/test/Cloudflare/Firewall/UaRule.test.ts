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

// Deterministic per-test User-Agent strings. A UA rule's User-Agent value
// is its identity within a zone (duplicates are rejected), so each test
// owns disjoint values and the same strings are reused on every run
// (never Date.now()/random).
const UA_LIFECYCLE_V1 = "AlchemyTestBot/1.0 (+https://alchemy.run)";
const UA_LIFECYCLE_V2 = "AlchemyTestBot/2.0 (+https://alchemy.run)";
const UA_LIST = "AlchemyListBot/1.0 (+https://alchemy.run)";

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

const getUaRule = (zoneId: string, uaRuleId: string) =>
  firewall.getUaRule({ zoneId, uaRuleId }).pipe(Effect.retry(forbiddenRetry));

// List every rule matching one of the given User-Agent strings — used to
// purge leftovers from interrupted runs so each test starts from a clean
// slate (a leaked rule would surface as Unowned/duplicate because the
// User-Agent value is identity).
const listByUserAgents = (zoneId: string, userAgents: string[]) =>
  firewall.listUaRules.items({ zoneId }).pipe(
    Stream.filter((r) => userAgents.includes(r.configuration?.value ?? "")),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry(forbiddenRetry),
  );

const purgeUaRules = (zoneId: string, userAgents: string[]) =>
  listByUserAgents(zoneId, userAgents).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        firewall.deleteUaRule({ zoneId, uaRuleId: r.id ?? "" }).pipe(
          Effect.retry(forbiddenRetry),
          Effect.catchTag("UaRuleNotFound", () => Effect.void),
        ),
      ),
    ),
  );

// Poll until the rule is gone — a missing rule surfaces as the typed
// `UaRuleNotFound` (Cloudflare code 10001, firewalluablock.api.not_found).
const expectUaRuleGone = (zoneId: string, uaRuleId: string) =>
  getUaRule(zoneId, uaRuleId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "UaRuleNotDeleted" } as const)),
    Effect.catchTag("UaRuleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "UaRuleNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update mode/paused/description/userAgent in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeUaRules(zoneId, [UA_LIFECYCLE_V1, UA_LIFECYCLE_V2]);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.UaRule("LifecycleUaRule", {
            zoneId,
            userAgent: UA_LIFECYCLE_V1,
            mode: "block",
            description: "alchemy ua rule test (v1)",
          }).pipe(adopt(true));
        }),
      );

      expect(initial.uaRuleId).toBeDefined();
      expect(initial.zoneId).toEqual(zoneId);
      expect(initial.userAgent).toEqual(UA_LIFECYCLE_V1);
      expect(initial.mode).toEqual("block");
      expect(initial.description).toEqual("alchemy ua rule test (v1)");
      expect(initial.paused).toEqual(false);

      const live = yield* getUaRule(zoneId, initial.uaRuleId);
      expect(live.id).toEqual(initial.uaRuleId);
      expect(live.configuration?.value).toEqual(UA_LIFECYCLE_V1);
      expect(live.mode).toEqual("block");

      // Update every mutable aspect in one PUT: new User-Agent value, a
      // softer mode, a new description, and pause the rule — all in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.UaRule("LifecycleUaRule", {
            zoneId,
            userAgent: UA_LIFECYCLE_V2,
            mode: "managed_challenge",
            description: "alchemy ua rule test (v2)",
            paused: true,
          }).pipe(adopt(true));
        }),
      );

      // Same rule updated in place — not a replacement.
      expect(updated.uaRuleId).toEqual(initial.uaRuleId);
      expect(updated.userAgent).toEqual(UA_LIFECYCLE_V2);
      expect(updated.mode).toEqual("managed_challenge");
      expect(updated.description).toEqual("alchemy ua rule test (v2)");
      expect(updated.paused).toEqual(true);

      const liveUpdated = yield* getUaRule(zoneId, updated.uaRuleId);
      expect(liveUpdated.configuration?.value).toEqual(UA_LIFECYCLE_V2);
      expect(liveUpdated.mode).toEqual("managed_challenge");
      expect(liveUpdated.description).toEqual("alchemy ua rule test (v2)");
      expect(liveUpdated.paused).toEqual(true);

      // Redeploying identical props is a no-op (still the same rule).
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.UaRule("LifecycleUaRule", {
            zoneId,
            userAgent: UA_LIFECYCLE_V2,
            mode: "managed_challenge",
            description: "alchemy ua rule test (v2)",
            paused: true,
          }).pipe(adopt(true));
        }),
      );
      expect(noop.uaRuleId).toEqual(initial.uaRuleId);

      yield* stack.destroy();

      yield* expectUaRuleGone(zoneId, initial.uaRuleId);
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): UA rules live inside a
// zone with no account-wide list, so `list()` enumerates every zone via
// `listAllZones` and exhaustively paginates each. Deploy one rule and assert
// it appears in the result, hydrated into the full `read` Attributes shape.
test.provider("list enumerates UA rules across all zones", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeUaRules(zoneId, [UA_LIST]);

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.UaRule("ListUaRule", {
          zoneId,
          userAgent: UA_LIST,
          mode: "block",
          description: "alchemy ua rule list test",
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Firewall.UaRule);
    const all = yield* provider.list();

    const found = all.find((r) => r.uaRuleId === deployed.uaRuleId);
    expect(found).toBeDefined();
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.userAgent).toEqual(UA_LIST);
    expect(found?.mode).toEqual("block");

    yield* stack.destroy();
    yield* purgeUaRules(zoneId, [UA_LIST]);
  }).pipe(logLevel),
);
