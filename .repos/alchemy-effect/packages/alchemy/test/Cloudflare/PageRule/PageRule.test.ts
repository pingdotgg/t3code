import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as pageRules from "@distilled.cloud/cloudflare/page-rules";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
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

// Deterministic per-test URL targets. Each test owns a disjoint path so
// reruns never collide, and the same target is reused on every run (never
// derive identity from Date.now()/random). Free zones allow only 3 Page
// Rules — every test starts and ends clean to stay within quota.
const TARGET_DEFAULT = `${zoneName}/alchemy-pagerule-default/*`;
const TARGET_UPDATE = `${zoneName}/alchemy-pagerule-update/*`;
const TARGET_UPDATE_MOVED = `${zoneName}/alchemy-pagerule-update-moved/*`;
const TARGET_ADOPT = `${zoneName}/alchemy-pagerule-adopt/*`;
const TARGET_LIST = `${zoneName}/alchemy-pagerule-list/*`;

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
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band verification calls by retrying the typed `Forbidden`
// error (part of each page-rules operation's error union via distilled
// patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const targetOf = (rule: {
  targets: ReadonlyArray<{ constraint?: { value: string } | null }>;
}) => rule.targets[0]?.constraint?.value;

const listRules = (zoneId: string) =>
  retryForbidden(pageRules.listPageRules({ zoneId }));

const findRule = (zoneId: string, target: string) =>
  listRules(zoneId).pipe(
    Effect.map((rules) => rules.find((r) => targetOf(r) === target)),
  );

const getRule = (zoneId: string, pageruleId: string) =>
  retryForbidden(pageRules.getPageRule({ zoneId, pageruleId }));

// Delete every rule matching one of our deterministic targets — used to
// purge leftovers from interrupted runs so tests start from a clean slate
// (and stay within the free-plan quota of 3 rules).
const purgeRules = (zoneId: string, targets: ReadonlyArray<string>) =>
  listRules(zoneId).pipe(
    Effect.flatMap(
      Effect.forEach((rule) =>
        targets.includes(targetOf(rule) ?? "")
          ? pageRules
              .deletePageRule({ zoneId, pageruleId: rule.id })
              .pipe(Effect.catchTag("PageRuleNotFound", () => Effect.void))
          : Effect.void,
      ),
    ),
  );

test.provider("create, verify out-of-band, and destroy a page rule", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeRules(zoneId, [TARGET_DEFAULT]);

    const rule = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.PageRule.PageRule("DefaultRule", {
          zoneId,
          target: TARGET_DEFAULT,
          actions: [
            { id: "cache_level", value: "cache_everything" },
            { id: "edge_cache_ttl", value: 7200 },
          ],
        }).pipe(adopt(true));
      }),
    );

    expect(rule.pageRuleId).toBeDefined();
    expect(rule.zoneId).toEqual(zoneId);
    expect(rule.target).toEqual(TARGET_DEFAULT);
    // Alchemy defaults differ from the raw API: status active, priority 1.
    expect(rule.status).toEqual("active");
    expect(rule.priority).toEqual(1);

    const live = yield* getRule(zoneId, rule.pageRuleId);
    expect(live.id).toEqual(rule.pageRuleId);
    expect(targetOf(live)).toEqual(TARGET_DEFAULT);
    expect(live.status).toEqual("active");
    const actionIds = live.actions.map((a) => a.id).sort();
    expect(actionIds).toEqual(["cache_level", "edge_cache_ttl"]);

    yield* stack.destroy();

    const gone = yield* findRule(zoneId, TARGET_DEFAULT);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

test.provider(
  "updating actions, status, priority and target syncs in place",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRules(zoneId, [TARGET_UPDATE, TARGET_UPDATE_MOVED]);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageRule.PageRule("UpdateRule", {
            zoneId,
            target: TARGET_UPDATE,
            actions: [{ id: "cache_level", value: "bypass" }],
            status: "disabled",
          }).pipe(adopt(true));
        }),
      );

      expect(initial.status).toEqual("disabled");
      expect(initial.target).toEqual(TARGET_UPDATE);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageRule.PageRule("UpdateRule", {
            zoneId,
            // Targets are mutable via PUT — same rule, new URL pattern.
            target: TARGET_UPDATE_MOVED,
            actions: [
              { id: "cache_level", value: "cache_everything" },
              { id: "browser_cache_ttl", value: 3600 },
            ],
            status: "active",
          }).pipe(adopt(true));
        }),
      );

      // Same rule updated in place — not a replacement.
      expect(updated.pageRuleId).toEqual(initial.pageRuleId);
      expect(updated.target).toEqual(TARGET_UPDATE_MOVED);
      expect(updated.status).toEqual("active");
      // Cloudflare clamps priority to the number of rules on the zone
      // (priority is positional) — a lone rule is always priority 1.
      expect(updated.priority).toEqual(1);

      const live = yield* getRule(zoneId, updated.pageRuleId);
      expect(targetOf(live)).toEqual(TARGET_UPDATE_MOVED);
      expect(live.status).toEqual("active");
      const actionIds = live.actions.map((a) => a.id).sort();
      expect(actionIds).toEqual(["browser_cache_ttl", "cache_level"]);

      // Re-deploying the identical desired state is a no-op (sync skips
      // the PUT entirely) and keeps the same physical rule.
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageRule.PageRule("UpdateRule", {
            zoneId,
            target: TARGET_UPDATE_MOVED,
            actions: [
              { id: "cache_level", value: "cache_everything" },
              { id: "browser_cache_ttl", value: 3600 },
            ],
            status: "active",
          }).pipe(adopt(true));
        }),
      );
      expect(noop.pageRuleId).toEqual(initial.pageRuleId);

      yield* stack.destroy();

      const gone = yield* findRule(zoneId, TARGET_UPDATE_MOVED);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

test.provider(
  "adoption — existing rule errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRules(zoneId, [TARGET_ADOPT]);

      // Create the rule out-of-band so the stack has no state of its own
      // for it — exactly the "the rule already exists" scenario.
      const pre = yield* retryForbidden(
        pageRules.createPageRule({
          zoneId,
          targets: [
            {
              target: "url",
              constraint: { operator: "matches", value: TARGET_ADOPT },
            },
          ],
          actions: [{ id: "cache_level", value: "bypass" }],
          status: "active",
        }),
      );
      expect(pre.id).toBeDefined();

      // Without `adopt`: Page Rules carry no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.PageRule.PageRule("AdoptedRule", {
              zoneId,
              target: TARGET_ADOPT,
              actions: [{ id: "cache_level", value: "cache_everything" }],
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing rule
      // (same physical id) and converges it to the desired actions.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.PageRule.PageRule("AdoptedRule", {
            zoneId,
            target: TARGET_ADOPT,
            actions: [{ id: "cache_level", value: "cache_everything" }],
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.pageRuleId).toEqual(pre.id);

      const live = yield* getRule(zoneId, adopted.pageRuleId);
      const cacheLevel = live.actions.find((a) => a.id === "cache_level");
      expect(
        cacheLevel?.id === "cache_level" ? cacheLevel.value : undefined,
      ).toEqual("cache_everything");

      yield* stack.destroy();

      const gone = yield* findRule(zoneId, TARGET_ADOPT);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): `list()` enumerates
// every zone via `listAllZones` and lists each zone's Page Rules, hydrating
// each into the same `Attributes` shape `read` returns. Deploy a rule with a
// deterministic target, then assert it appears in the exhaustive result.
test.provider("list enumerates the deployed page rule", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeRules(zoneId, [TARGET_LIST]);

    const rule = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.PageRule.PageRule("ListRule", {
          zoneId,
          target: TARGET_LIST,
          actions: [{ id: "cache_level", value: "cache_everything" }],
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.PageRule.PageRule);
    const all = yield* provider.list();

    expect(all.some((r) => r.pageRuleId === rule.pageRuleId)).toBe(true);
    const found = all.find((r) => r.pageRuleId === rule.pageRuleId);
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.target).toEqual(TARGET_LIST);

    yield* stack.destroy();

    const gone = yield* findRule(zoneId, TARGET_LIST);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );
