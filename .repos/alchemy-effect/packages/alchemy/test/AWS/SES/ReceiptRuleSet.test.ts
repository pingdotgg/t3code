import * as AWS from "@/AWS";
import { ReceiptRuleSet } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as ses from "@distilled.cloud/aws/ses";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class RuleSetStillExists extends Data.TaggedError("RuleSetStillExists")<{
  readonly name: string;
}> {}

const assertRuleSetDeleted = (name: string) =>
  ses.describeReceiptRuleSet({ RuleSetName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new RuleSetStillExists({ name }))),
    Effect.catchTag("RuleSetDoesNotExistException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleSetStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "receipt rule set lifecycle: create, no-op convergence, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ruleSet = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptRuleSet("Inbound", {});
        }),
      );

      expect(ruleSet.ruleSetName).toBeDefined();

      // out-of-band verification via distilled
      const observed = yield* ses.describeReceiptRuleSet({
        RuleSetName: ruleSet.ruleSetName,
      });
      expect(observed.Metadata?.Name).toBe(ruleSet.ruleSetName);

      // re-deploy converges to a no-op (the set already exists)
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptRuleSet("Inbound", {});
        }),
      );
      expect(again.ruleSetName).toBe(ruleSet.ruleSetName);

      yield* stack.destroy();
      yield* assertRuleSetDeleted(ruleSet.ruleSetName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptRuleSet("Named", {
            ruleSetName: "alchemy-test-ses-ruleset-a",
          });
        }),
      );
      expect(first.ruleSetName).toBe("alchemy-test-ses-ruleset-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptRuleSet("Named", {
            ruleSetName: "alchemy-test-ses-ruleset-b",
          });
        }),
      );
      expect(second.ruleSetName).toBe("alchemy-test-ses-ruleset-b");
      yield* assertRuleSetDeleted("alchemy-test-ses-ruleset-a");

      yield* stack.destroy();
      yield* assertRuleSetDeleted("alchemy-test-ses-ruleset-b");
    }),
  { timeout: 120_000 },
);
