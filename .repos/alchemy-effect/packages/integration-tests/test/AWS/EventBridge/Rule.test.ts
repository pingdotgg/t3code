import * as AWS from "@alchemy.run/aws";
import { Rule } from "@alchemy.run/aws/EventBridge/Rule";
import { Queue } from "@alchemy.run/aws/SQS/Queue";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftActions, driftOf, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

/** Typed wait-until-gone: poll describeRule until ResourceNotFoundException. */
const assertRuleGone = Effect.fn(function* (name: string) {
  const gone = yield* eventbridge.describeRule({ Name: name }).pipe(
    Effect.map(() => false),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (isGone): boolean => isGone,
      times: 10,
    }),
  );
  expect(gone).toBe(true);
});

// Canonical `list()` test (AWS account/region-scoped collection across all
// event buses): deploy a real rule, resolve the provider from context via the
// typed `findProvider`, call `list()`, and assert the deployed rule appears in
// the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Rule("ListRule", {
            name: "alchemy-test-rule-list",
            scheduleExpression: "rate(5 minutes)",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Rule);
      const all = yield* provider.list();

      expect(all.some((r) => r.ruleName === rule.ruleName)).toBe(true);
      expect(
        all.some((r) => r.ruleName === rule.ruleName && r.eventBusName === rule.eventBusName),
      ).toBe(true);

      yield* stack.destroy();

      yield* assertRuleGone("alchemy-test-rule-list");
    }),
  {
    tags: ["provider:aws", "provider:aws:eventbridge", "live"],
    timeout: 120_000,
  },
);

// #2688: `read` must observe the rule definition and its targets, or a rule
// disabled or retargeted out of band reads as `unchanged`.
test.provider(
  "drift detects and repairs out-of-band rule state and target changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("DriftRuleQueue", {});
          return yield* Rule("DriftRule", {
            eventPattern: { source: ["alchemy.drift"] },
            targets: [
              {
                Id: "queue",
                Arn: queue.queueArn,
                RetryPolicy: { MaximumRetryAttempts: 3 },
              },
            ],
          });
        }),
      );
      const actions = yield* driftActions(stack);
      expect(Object.values(actions).every((action) => action === "unchanged")).toBe(true);

      yield* eventbridge.disableRule({ Name: rule.ruleName });
      const { Targets } = yield* eventbridge.listTargetsByRule({ Rule: rule.ruleName });
      yield* eventbridge.putTargets({
        Rule: rule.ruleName,
        Targets: (Targets ?? []).map((target) => ({
          ...target,
          RetryPolicy: { MaximumRetryAttempts: 0 },
        })),
      });

      const drifted = yield* waitForDrift(stack, "DriftRule", "drifted");
      expect(drifted?.attr?.configuration?.state).toBe("DISABLED");
      expect(drifted?.attr?.configuration?.targets?.[0]?.RetryPolicy?.MaximumRetryAttempts).toBe(0);

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.DriftRule?.action).toBe("repaired");
      expect((yield* driftOf(stack, "DriftRule"))?.action).toBe("unchanged");
      const restored = yield* eventbridge.describeRule({ Name: rule.ruleName });
      expect(restored.State).toBe("ENABLED");
      const targets = yield* eventbridge.listTargetsByRule({ Rule: rule.ruleName });
      expect(targets.Targets?.[0]?.RetryPolicy?.MaximumRetryAttempts).toBe(3);

      yield* stack.destroy();
      yield* assertRuleGone(rule.ruleName);
    }),
  {
    tags: ["provider:aws", "provider:aws:eventbridge", "provider:aws:sqs", "live"],
    timeout: 120_000,
  },
);
