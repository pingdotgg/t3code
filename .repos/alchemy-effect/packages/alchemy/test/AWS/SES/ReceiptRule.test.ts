import * as AWS from "@/AWS";
import { ReceiptRule, ReceiptRuleSet } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as ses from "@distilled.cloud/aws/ses";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class RuleStillExists extends Data.TaggedError("RuleStillExists")<{
  readonly ruleSetName: string;
  readonly ruleName: string;
}> {}

const assertRuleDeleted = (ruleSetName: string, ruleName: string) =>
  ses
    .describeReceiptRule({ RuleSetName: ruleSetName, RuleName: ruleName })
    .pipe(
      Effect.flatMap(() =>
        Effect.fail(new RuleStillExists({ ruleSetName, ruleName })),
      ),
      Effect.catchTag(
        ["RuleDoesNotExistException", "RuleSetDoesNotExistException"],
        () => Effect.void,
      ),
      Effect.retry({
        while: (e) => e._tag === "RuleStillExists",
        schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
      }),
    );

test.provider(
  "receipt rule lifecycle: create with actions, update in place, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { ruleSet, rule } = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* ReceiptRuleSet("RuleLifecycleSet", {});
          const rule = yield* ReceiptRule("Rule", {
            ruleSetName: ruleSet.ruleSetName,
            recipients: ["support@ses-bindings.alchemy-test.example.com"],
            scanEnabled: true,
            actions: [
              {
                AddHeaderAction: {
                  HeaderName: "X-Alchemy-Test",
                  HeaderValue: "inbound",
                },
              },
              { StopAction: { Scope: "RuleSet" } },
            ],
          });
          return { ruleSet, rule };
        }),
      );

      expect(rule.ruleName).toBeDefined();
      expect(rule.ruleSetName).toBe(ruleSet.ruleSetName);

      // out-of-band verification via distilled
      const observed = yield* ses.describeReceiptRule({
        RuleSetName: ruleSet.ruleSetName,
        RuleName: rule.ruleName,
      });
      expect(observed.Rule?.Name).toBe(rule.ruleName);
      // `enabled` was omitted: the provider must apply the documented default
      // (the wire API defaults an omitted Enabled to false, which would
      // silently bounce all inbound mail).
      expect(observed.Rule?.Enabled).toBe(true);
      expect(observed.Rule?.ScanEnabled).toBe(true);
      expect(observed.Rule?.Actions?.[0]?.AddHeaderAction?.HeaderValue).toBe(
        "inbound",
      );
      expect(observed.Rule?.Recipients).toEqual([
        "support@ses-bindings.alchemy-test.example.com",
      ]);

      // update in place: swap the action set, disable scanning, require TLS.
      // (A BounceAction is not usable here — SES validates its Sender against
      // the account's verified identities at update time; see the probe test
      // below.)
      yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* ReceiptRuleSet("RuleLifecycleSet", {});
          yield* ReceiptRule("Rule", {
            ruleSetName: ruleSet.ruleSetName,
            enabled: false,
            scanEnabled: false,
            tlsPolicy: "Require",
            actions: [
              {
                AddHeaderAction: {
                  HeaderName: "X-Alchemy-Test",
                  HeaderValue: "updated",
                },
              },
            ],
          });
        }),
      );
      const updated = yield* ses.describeReceiptRule({
        RuleSetName: ruleSet.ruleSetName,
        RuleName: rule.ruleName,
      });
      expect(updated.Rule?.Enabled).toBe(false);
      expect(updated.Rule?.ScanEnabled).toBe(false);
      expect(updated.Rule?.TlsPolicy).toBe("Require");
      expect(updated.Rule?.Actions).toHaveLength(1);
      expect(updated.Rule?.Actions?.[0]?.AddHeaderAction?.HeaderValue).toBe(
        "updated",
      );

      yield* stack.destroy();
      yield* assertRuleDeleted(ruleSet.ruleSetName, rule.ruleName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "renaming a rule replaces it within the same rule set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The rule set stays deployed across the replacement so the engine never
      // has to remove a dependency of the resource being replaced.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* ReceiptRuleSet("RenameSet", {});
          const rule = yield* ReceiptRule("RenameRule", {
            ruleSetName: ruleSet.ruleSetName,
            ruleName: "alchemy-test-rule-a",
            actions: [{ StopAction: { Scope: "RuleSet" } }],
          });
          return { ruleSetName: ruleSet.ruleSetName, ruleName: rule.ruleName };
        }),
      );
      expect(first.ruleName).toBe("alchemy-test-rule-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* ReceiptRuleSet("RenameSet", {});
          const rule = yield* ReceiptRule("RenameRule", {
            ruleSetName: ruleSet.ruleSetName,
            ruleName: "alchemy-test-rule-b",
            actions: [{ StopAction: { Scope: "RuleSet" } }],
          });
          return { ruleSetName: ruleSet.ruleSetName, ruleName: rule.ruleName };
        }),
      );
      expect(second.ruleName).toBe("alchemy-test-rule-b");
      yield* assertRuleDeleted(first.ruleSetName, "alchemy-test-rule-a");

      yield* stack.destroy();
      yield* assertRuleDeleted(second.ruleSetName, "alchemy-test-rule-b");
    }),
  { timeout: 120_000 },
);

test.provider(
  "rules are ordered by the `after` position",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { ruleSetName } = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* ReceiptRuleSet("OrderSet", {});
          const first = yield* ReceiptRule("First", {
            ruleSetName: ruleSet.ruleSetName,
            ruleName: "alchemy-test-order-first",
            actions: [{ StopAction: { Scope: "RuleSet" } }],
          });
          yield* ReceiptRule("Second", {
            ruleSetName: ruleSet.ruleSetName,
            ruleName: "alchemy-test-order-second",
            after: first.ruleName,
            actions: [{ StopAction: { Scope: "RuleSet" } }],
          });
          return { ruleSetName: ruleSet.ruleSetName };
        }),
      );

      // out-of-band: the rule set lists rules in evaluation order
      const observed = yield* ses.describeReceiptRuleSet({
        RuleSetName: ruleSetName,
      });
      const order = (observed.Rules ?? []).map((r) => r.Name);
      expect(order.indexOf("alchemy-test-order-first")).toBeLessThan(
        order.indexOf("alchemy-test-order-second"),
      );

      yield* stack.destroy();
      yield* assertRuleDeleted(ruleSetName, "alchemy-test-order-first");
    }),
  { timeout: 120_000 },
);

// Ungated probe: SES validates a BounceAction's Sender against the account's
// verified identities at create/update time. In the sandbox (no verified
// identities) that rejection surfaces as the typed IdentityNotVerified tag —
// carved out of the classic API's untyped InvalidParameterValue by the
// distilled ses patch. This pins the patch forever at near-zero cost; on an
// account where the identity IS verified the create simply succeeds.
test.provider(
  "a BounceAction with an unverified Sender fails with the typed IdentityNotVerified tag",
  () =>
    Effect.gen(function* () {
      const ruleSetName = "alchemy-test-bounce-sender-probe";
      yield* ses
        .createReceiptRuleSet({ RuleSetName: ruleSetName })
        .pipe(Effect.catchTag("AlreadyExistsException", () => Effect.void));

      const created = yield* Effect.result(
        ses.createReceiptRule({
          RuleSetName: ruleSetName,
          Rule: {
            Name: "probe",
            Actions: [
              {
                BounceAction: {
                  SmtpReplyCode: "550",
                  Message: "Mailbox does not exist",
                  Sender: "mailer-daemon@ses-bindings.alchemy-test.example.com",
                },
              },
            ],
          },
        }),
      );
      if (Result.isFailure(created)) {
        expect(created.failure._tag).toBe("IdentityNotVerified");
      }
    }).pipe(
      Effect.ensuring(
        ses
          .deleteReceiptRuleSet({
            RuleSetName: "alchemy-test-bounce-sender-probe",
          })
          .pipe(Effect.ignore),
      ),
    ),
  { timeout: 60_000 },
);
