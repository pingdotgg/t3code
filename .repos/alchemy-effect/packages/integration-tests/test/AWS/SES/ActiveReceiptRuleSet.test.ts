import * as AWS from "@alchemy.run/aws";
import { ActiveReceiptRuleSet, ReceiptRuleSet } from "@alchemy.run/aws/SES";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ses from "@distilled.cloud/aws/ses";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const activeRuleSetName = ses
  .describeActiveReceiptRuleSet({})
  .pipe(Effect.map((response) => response.Metadata?.Name));

// Account-singleton pointer: capture whatever the account currently points at,
// run the lifecycle, then restore it. The "aws:ses-account" label keeps the
// other SES account-singleton tests from observing the mutated active pointer.
test.provider(
  "active receipt rule set: point the account at a rule set, then deactivate",
  (stack) =>
    Effect.gen(function* () {
      const captured = yield* activeRuleSetName;

      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const { ruleSet } = yield* stack.deploy(
          Effect.gen(function* () {
            const ruleSet = yield* ReceiptRuleSet("ActiveSet", {});
            yield* ActiveReceiptRuleSet("Active", {
              ruleSetName: ruleSet.ruleSetName,
            });
            return { ruleSet };
          }),
        );

        // out-of-band verification via distilled: the account now points here
        const active = yield* activeRuleSetName;
        expect(active).toBe(ruleSet.ruleSetName);

        yield* stack.destroy();

        // deleting our pointer deactivated receiving (we still owned it)
        const afterDestroy = yield* activeRuleSetName;
        expect(afterDestroy).not.toBe(ruleSet.ruleSetName);
      }).pipe(
        Effect.ensuring(
          captured
            ? ses.setActiveReceiptRuleSet({ RuleSetName: captured }).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:ses", "live"],
    timeout: 120_000,
    exclusive: "aws:ses-account",
  },
);
