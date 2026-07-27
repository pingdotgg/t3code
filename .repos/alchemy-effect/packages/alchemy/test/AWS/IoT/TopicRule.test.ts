import * as AWS from "@/AWS";
import { TopicRule } from "@/AWS/IoT";
import * as Test from "@/Test/Alchemy";
import * as iot from "@distilled.cloud/aws/iot";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// A syntactically valid Lambda ARN for a function that need not exist —
// createTopicRule validates the ARN shape, not existence.
const FAKE_LAMBDA_ARN =
  "arn:aws:lambda:us-west-2:391965393224:function:alchemy-iot-topicrule-test";

const assertRuleGone = (ruleName: string) =>
  iot.getTopicRule({ ruleName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`topic rule ${ruleName} still exists`)),
    ),
    Effect.catchTag("TopicRuleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe.sequential("AWS.IoT.TopicRule", () => {
  test.provider(
    "creates, updates the SQL in place, and deletes a topic rule",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const rule = yield* TopicRule("Rule", {
              sql: "SELECT * FROM 'alchemy/iot/test/v1'",
              actions: [{ lambda: { functionArn: FAKE_LAMBDA_ARN } }],
            });
            return { ruleName: rule.ruleName, ruleArn: rule.ruleArn };
          }),
        );

        // Verify out-of-band.
        const observed = yield* iot.getTopicRule({
          ruleName: created.ruleName,
        });
        expect(observed.rule?.sql).toEqual(
          "SELECT * FROM 'alchemy/iot/test/v1'",
        );

        // Update the SQL — same name, so this is an in-place replaceTopicRule.
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TopicRule("Rule", {
              sql: "SELECT temperature FROM 'alchemy/iot/test/v2'",
              actions: [{ lambda: { functionArn: FAKE_LAMBDA_ARN } }],
            });
          }),
        );
        const updated = yield* iot.getTopicRule({ ruleName: created.ruleName });
        expect(updated.rule?.sql).toEqual(
          "SELECT temperature FROM 'alchemy/iot/test/v2'",
        );

        yield* stack.destroy();
        yield* assertRuleGone(created.ruleName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "getTopicRule on a missing rule surfaces the typed TopicRuleNotFound tag",
    () =>
      Effect.gen(function* () {
        const result = yield* iot
          .getTopicRule({ ruleName: "alchemy_definitely_missing_rule_xyz" })
          .pipe(Effect.flip);
        expect(result._tag).toEqual("TopicRuleNotFound");
      }),
    { timeout: 60_000 },
  );
});
