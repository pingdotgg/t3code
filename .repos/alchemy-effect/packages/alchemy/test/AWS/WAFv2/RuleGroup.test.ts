import * as AWS from "@/AWS";
import { RuleGroup } from "@/AWS/WAFv2";
import * as Test from "@/Test/Alchemy";
import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class RuleGroupStillExists extends Data.TaggedError("RuleGroupStillExists")<{
  readonly name: string;
}> {}

const assertRuleGroupDeleted = (name: string, id: string) =>
  wafv2.getRuleGroup({ Name: name, Scope: "REGIONAL", Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new RuleGroupStillExists({ name }))),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleGroupStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

const visibility = (metricName: string): WAFV2.VisibilityConfig => ({
  SampledRequestsEnabled: true,
  CloudWatchMetricsEnabled: true,
  MetricName: metricName,
});

const blockPathRule = (searchString: string): WAFV2.Rule => ({
  Name: "block-path",
  Priority: 0,
  Statement: {
    ByteMatchStatement: {
      SearchString: new TextEncoder().encode(searchString),
      FieldToMatch: { UriPath: {} },
      TextTransformations: [{ Priority: 0, Type: "LOWERCASE" }],
      PositionalConstraint: "STARTS_WITH",
    },
  },
  Action: { Block: {} },
  VisibilityConfig: visibility("block-path"),
});

test.provider(
  "create, update rules, replace on capacity change, delete",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RuleGroup("LifecycleRuleGroup", {
            capacity: 50,
            rules: [blockPathRule("/admin")],
            tags: { Environment: "test" },
          });
        }),
      );

      expect(group.capacity).toBe(50);
      expect(group.scope).toBe("REGIONAL");
      expect(group.ruleGroupArn).toContain("/rulegroup/");

      // out-of-band verification via distilled
      const created = yield* wafv2.getRuleGroup({
        Name: group.ruleGroupName,
        Scope: "REGIONAL",
        Id: group.ruleGroupId,
      });
      expect(created.RuleGroup?.Capacity).toBe(50);
      expect(created.RuleGroup?.Rules?.length).toBe(1);
      expect(
        created.RuleGroup?.Rules?.[0]?.Statement?.ByteMatchStatement
          ?.PositionalConstraint,
      ).toBe("STARTS_WITH");

      const tags = yield* wafv2.listTagsForResource({
        ResourceARN: group.ruleGroupArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.TagInfoForResource?.TagList ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord["alchemy::id"]).toBe("LifecycleRuleGroup");

      // rules are mutable within the fixed capacity — updated in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RuleGroup("LifecycleRuleGroup", {
            capacity: 50,
            rules: [blockPathRule("/internal")],
            description: "blocks internal paths",
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.ruleGroupId).toBe(group.ruleGroupId);

      const afterUpdate = yield* wafv2.getRuleGroup({
        Name: group.ruleGroupName,
        Scope: "REGIONAL",
        Id: group.ruleGroupId,
      });
      expect(afterUpdate.RuleGroup?.Description).toBe("blocks internal paths");
      const search =
        afterUpdate.RuleGroup?.Rules?.[0]?.Statement?.ByteMatchStatement
          ?.SearchString;
      expect(new TextDecoder().decode(search)).toBe("/internal");

      // capacity is immutable ⇒ replacement
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RuleGroup("LifecycleRuleGroup", {
            capacity: 60,
            rules: [blockPathRule("/internal")],
          });
        }),
      );
      expect(replaced.ruleGroupId).not.toBe(group.ruleGroupId);
      expect(replaced.capacity).toBe(60);
      yield* assertRuleGroupDeleted(group.ruleGroupName, group.ruleGroupId);

      yield* stack.destroy();
      yield* assertRuleGroupDeleted(
        replaced.ruleGroupName,
        replaced.ruleGroupId,
      );
    }),
  { timeout: 120_000 },
);
