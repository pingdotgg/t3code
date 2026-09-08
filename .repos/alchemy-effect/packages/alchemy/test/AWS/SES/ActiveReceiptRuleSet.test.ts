import * as AWS from "@/AWS";
import { ActiveReceiptRuleSet, ReceiptRuleSet } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as ses from "@distilled.cloud/aws/ses";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const activeRuleSetName = ses
  .describeActiveReceiptRuleSet({})
  .pipe(Effect.map((response) => response.Metadata?.Name));

// Account-singleton pointer: capture whatever the account currently points at,
// run the lifecycle, then restore it. `exclusive` takes the whole-process lock
// so no other test observes the mutated active pointer.
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
            ? ses
                .setActiveReceiptRuleSet({ RuleSetName: captured })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    }),
  { timeout: 120_000, exclusive: true },
);
