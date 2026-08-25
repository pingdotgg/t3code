import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Advanced TCP Protection is a Magic Transit (Enterprise add-on)
// entitlement that the testing account does not have — every API call fails
// with the typed `AdvancedTcpProtectionNotEntitled` error (Cloudflare code
// 8888; asserted in AllowlistEntry.test.ts). The lifecycle suite is gated
// behind an opt-in env var for entitled accounts.
const magicTransit = process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

const accountId = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return accountId;
});

test.provider.skipIf(!magicTransit)(
  "creates a global SYN protection rule, updates it in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const acct = yield* accountId;

      yield* stack.destroy();

      // Create.
      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.SynProtectionRule("Rule", {
            scope: "global",
            mode: "monitoring",
            burstSensitivity: "medium",
            rateSensitivity: "medium",
          });
        }),
      );
      expect(rule.scope).toEqual("global");
      expect(rule.name).toEqual("global");
      expect(rule.mode).toEqual("monitoring");

      // Out-of-band verification via the distilled API.
      const live = yield* ddos.getAdvancedTcpProtectionSynProtectionRuleItem({
        accountId: acct,
        ruleId: rule.ruleId,
      });
      expect(live.mode).toEqual("monitoring");
      expect(live.burstSensitivity).toEqual("medium");

      // In-place update — mode and sensitivities are patched, id is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.SynProtectionRule("Rule", {
            scope: "global",
            mode: "disabled",
            burstSensitivity: "high",
            rateSensitivity: "low",
          });
        }),
      );
      expect(updated.ruleId).toEqual(rule.ruleId);
      expect(updated.mode).toEqual("disabled");
      expect(updated.burstSensitivity).toEqual("high");
      expect(updated.rateSensitivity).toEqual("low");

      yield* stack.destroy();

      // Gone — the typed SynProtectionRuleNotFound error proves deletion.
      const error = yield* ddos
        .getAdvancedTcpProtectionSynProtectionRuleItem({
          accountId: acct,
          ruleId: rule.ruleId,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SynProtectionRuleNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Ungated: list() enumerates every rule in the ambient account. On the
// unentitled testing account the typed `AdvancedTcpProtectionNotEntitled`
// (Cloudflare code 8888) / `Forbidden` rejection is caught and surfaces as a
// well-typed empty array — proving list() is resilient on accounts without
// the Advanced TCP Protection entitlement.
test.provider(
  "list returns a well-typed array of SYN protection rules",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.DdosProtection.SynProtectionRule,
      );
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      for (const r of all) {
        expect(typeof r.ruleId).toBe("string");
        expect(typeof r.accountId).toBe("string");
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Gated full lifecycle: on an entitled account, a deployed rule must appear
// in the exhaustively-paginated list().
test.provider.skipIf(!magicTransit)(
  "list enumerates the deployed SYN protection rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.SynProtectionRule(
            "ListRule",
            {
              scope: "global",
              mode: "monitoring",
              burstSensitivity: "medium",
              rateSensitivity: "medium",
            },
          );
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.DdosProtection.SynProtectionRule,
      );
      const all = yield* provider.list();
      expect(all.some((r) => r.ruleId === rule.ruleId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
