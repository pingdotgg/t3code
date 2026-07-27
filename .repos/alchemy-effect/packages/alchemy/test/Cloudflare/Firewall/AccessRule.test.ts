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

// Deterministic per-test configuration values (TEST-NET-2). A rule's
// configuration is its identity within a scope, so each test owns a disjoint
// IP and the same value is reused on every run (never Date.now()/random).
const IP_DEFAULT = "198.51.100.101";
const IP_UPDATE = "198.51.100.102";
const IP_REPLACE_OLD = "198.51.100.103";
const IP_REPLACE_NEW = "198.51.100.104";
const IP_ACCOUNT = "198.51.100.105";
const IP_LIST = "198.51.100.106";

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

const getZoneRule = (zoneId: string, ruleId: string) =>
  firewall
    .getAccessRuleForZone({ zoneId, ruleId })
    .pipe(Effect.retry(forbiddenRetry));

const getAccountRule = (accountId: string, ruleId: string) =>
  firewall
    .getAccessRuleForAccount({ accountId, ruleId })
    .pipe(Effect.retry(forbiddenRetry));

const listByIp = (
  scope: { zoneId: string } | { accountId: string },
  ip: string,
) =>
  ("zoneId" in scope
    ? firewall.listAccessRulesForZone.items({ zoneId: scope.zoneId })
    : firewall.listAccessRulesForAccount.items({ accountId: scope.accountId })
  ).pipe(
    Stream.filter(
      (r) => r.configuration.target === "ip" && r.configuration.value === ip,
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry(forbiddenRetry),
  );

// Delete every rule matching the ip — used to purge leftovers from
// interrupted runs so each test starts from a clean slate (a leaked rule
// would surface as Unowned/duplicate because configuration is identity).
const purgeRules = (
  scope: { zoneId: string } | { accountId: string },
  ip: string,
) =>
  listByIp(scope, ip).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        ("zoneId" in scope
          ? firewall.deleteAccessRuleForZone({
              zoneId: scope.zoneId,
              ruleId: r.id,
            })
          : firewall.deleteAccessRuleForAccount({
              accountId: scope.accountId,
              ruleId: r.id,
            })
        ).pipe(
          Effect.retry(forbiddenRetry),
          Effect.catchTag("AccessRuleNotFound", () => Effect.void),
        ),
      ),
    ),
  );

// Poll until the rule is gone — a missing rule surfaces as the typed
// `AccessRuleNotFound` (Cloudflare code 10001, firewallaccessrules.api.not_found).
const expectZoneRuleGone = (zoneId: string, ruleId: string) =>
  getZoneRule(zoneId, ruleId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "RuleNotDeleted" } as const)),
    Effect.catchTag("AccessRuleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const expectAccountRuleGone = (accountId: string, ruleId: string) =>
  getAccountRule(accountId, ruleId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "RuleNotDeleted" } as const)),
    Effect.catchTag("AccessRuleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create and delete a zone-scoped ip rule", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeRules({ zoneId }, IP_DEFAULT);

    const rule = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("DefaultRule", {
          zoneId,
          configuration: { target: "ip", value: IP_DEFAULT },
          mode: "challenge",
          notes: "alchemy firewall test (default)",
        }).pipe(adopt(true));
      }),
    );

    expect(rule.ruleId).toBeDefined();
    expect(rule.zoneId).toEqual(zoneId);
    expect(rule.accountId).toEqual(accountId);
    expect(rule.configuration).toEqual({ target: "ip", value: IP_DEFAULT });
    expect(rule.mode).toEqual("challenge");
    expect(rule.notes).toEqual("alchemy firewall test (default)");
    expect(rule.allowedModes).toContain("block");

    const live = yield* getZoneRule(zoneId, rule.ruleId);
    expect(live.id).toEqual(rule.ruleId);
    expect(live.configuration.value).toEqual(IP_DEFAULT);
    expect(live.mode).toEqual("challenge");

    yield* stack.destroy();

    yield* expectZoneRuleGone(zoneId, rule.ruleId);
  }).pipe(logLevel),
);

test.provider("update mode and notes in place (same ruleId)", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeRules({ zoneId }, IP_UPDATE);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("UpdateRule", {
          zoneId,
          configuration: { target: "ip", value: IP_UPDATE },
          mode: "challenge",
          notes: "v1",
        }).pipe(adopt(true));
      }),
    );

    expect(initial.mode).toEqual("challenge");
    expect(initial.notes).toEqual("v1");

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("UpdateRule", {
          zoneId,
          configuration: { target: "ip", value: IP_UPDATE },
          mode: "managed_challenge",
          notes: "v2",
        }).pipe(adopt(true));
      }),
    );

    // Same rule patched in place — not a replacement.
    expect(updated.ruleId).toEqual(initial.ruleId);
    expect(updated.mode).toEqual("managed_challenge");
    expect(updated.notes).toEqual("v2");

    const live = yield* getZoneRule(zoneId, updated.ruleId);
    expect(live.mode).toEqual("managed_challenge");
    expect(live.notes).toEqual("v2");

    // Redeploying identical props is a no-op (still the same rule).
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("UpdateRule", {
          zoneId,
          configuration: { target: "ip", value: IP_UPDATE },
          mode: "managed_challenge",
          notes: "v2",
        }).pipe(adopt(true));
      }),
    );
    expect(noop.ruleId).toEqual(initial.ruleId);

    yield* stack.destroy();

    yield* expectZoneRuleGone(zoneId, initial.ruleId);
  }).pipe(logLevel),
);

test.provider("changing the configuration triggers replacement", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeRules({ zoneId }, IP_REPLACE_OLD);
    yield* purgeRules({ zoneId }, IP_REPLACE_NEW);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("ReplaceRule", {
          zoneId,
          configuration: { target: "ip", value: IP_REPLACE_OLD },
          mode: "challenge",
        }).pipe(adopt(true));
      }),
    );

    expect(initial.configuration.value).toEqual(IP_REPLACE_OLD);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("ReplaceRule", {
          zoneId,
          configuration: { target: "ip", value: IP_REPLACE_NEW },
          mode: "challenge",
        }).pipe(adopt(true));
      }),
    );

    // The configuration is the rule's identity — a new physical rule exists.
    expect(replaced.ruleId).not.toEqual(initial.ruleId);
    expect(replaced.configuration.value).toEqual(IP_REPLACE_NEW);

    // The old rule was deleted as part of the replacement.
    yield* expectZoneRuleGone(zoneId, initial.ruleId);

    const live = yield* getZoneRule(zoneId, replaced.ruleId);
    expect(live.configuration.value).toEqual(IP_REPLACE_NEW);

    yield* stack.destroy();

    yield* expectZoneRuleGone(zoneId, replaced.ruleId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed zone-scoped rule", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeRules({ zoneId }, IP_LIST);

    const rule = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Firewall.AccessRule("ListRule", {
          zoneId,
          configuration: { target: "ip", value: IP_LIST },
          mode: "challenge",
          notes: "alchemy firewall test (list)",
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Firewall.AccessRule,
    );
    const all = yield* provider.list();

    const found = all.find((r) => r.ruleId === rule.ruleId);
    expect(found).toBeDefined();
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.configuration).toEqual({ target: "ip", value: IP_LIST });
    expect(found?.mode).toEqual("challenge");

    yield* stack.destroy();

    yield* expectZoneRuleGone(zoneId, rule.ruleId);
  }).pipe(logLevel),
);

test.provider(
  "account-scoped rule (no zoneId) create, update, delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeRules({ accountId }, IP_ACCOUNT);

      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.AccessRule("AccountRule", {
            configuration: { target: "ip", value: IP_ACCOUNT },
            mode: "challenge",
            notes: "alchemy firewall test (account)",
          }).pipe(adopt(true));
        }),
      );

      expect(rule.ruleId).toBeDefined();
      expect(rule.zoneId).toBeUndefined();
      expect(rule.accountId).toEqual(accountId);
      expect(rule.configuration).toEqual({ target: "ip", value: IP_ACCOUNT });
      expect(rule.mode).toEqual("challenge");

      const live = yield* getAccountRule(accountId, rule.ruleId);
      expect(live.id).toEqual(rule.ruleId);
      expect(live.configuration.value).toEqual(IP_ACCOUNT);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Firewall.AccessRule("AccountRule", {
            configuration: { target: "ip", value: IP_ACCOUNT },
            mode: "managed_challenge",
            notes: "alchemy firewall test (account, v2)",
          }).pipe(adopt(true));
        }),
      );

      expect(updated.ruleId).toEqual(rule.ruleId);
      expect(updated.mode).toEqual("managed_challenge");

      const liveUpdated = yield* getAccountRule(accountId, rule.ruleId);
      expect(liveUpdated.mode).toEqual("managed_challenge");

      yield* stack.destroy();

      yield* expectAccountRuleGone(accountId, rule.ruleId);
    }).pipe(logLevel),
);
