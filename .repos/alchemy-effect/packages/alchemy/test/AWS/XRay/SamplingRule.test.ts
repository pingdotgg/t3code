import * as AWS from "@/AWS";
import { SamplingRule } from "@/AWS/XRay";
import * as Test from "@/Test/Alchemy";
import * as xray from "@distilled.cloud/aws/xray";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const findRule = (ruleName: string) =>
  xray.getSamplingRules.items({}).pipe(
    Stream.filter((record) => record.SamplingRule?.RuleName === ruleName),
    Stream.runHead,
    Effect.map((record) => Option.getOrUndefined(record)?.SamplingRule),
  );

class SamplingRuleStillExists extends Data.TaggedError(
  "SamplingRuleStillExists",
)<{ readonly ruleName: string }> {}

const assertRuleDeleted = (ruleName: string) =>
  findRule(ruleName).pipe(
    Effect.flatMap((rule) =>
      rule === undefined
        ? Effect.void
        : Effect.fail(new SamplingRuleStillExists({ ruleName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "SamplingRuleStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update, no-op, delete sampling rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SamplingRule("TestRule", {
            priority: 9000,
            fixedRate: 0.05,
            reservoirSize: 1,
            serviceName: "alchemy-xray-test-*",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(rule.ruleName).toBeDefined();
      expect(rule.ruleArn).toContain(":sampling-rule/");

      // out-of-band verification via distilled
      const created = yield* findRule(rule.ruleName);
      expect(created?.Priority).toBe(9000);
      expect(created?.FixedRate).toBe(0.05);
      expect(created?.ReservoirSize).toBe(1);
      expect(created?.ServiceName).toBe("alchemy-xray-test-*");
      expect(created?.ServiceType).toBe("*");
      const tags = yield* xray
        .listTagsForResource({ ResourceARN: rule.ruleArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestRule");

      // update mutable fields (priority, rates, matchers, attributes, tags)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SamplingRule("TestRule", {
            priority: 8000,
            fixedRate: 0.1,
            reservoirSize: 2,
            serviceName: "alchemy-xray-test-*",
            httpMethod: "GET",
            attributes: { tier: "premium" },
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.ruleName).toBe(rule.ruleName);
      expect(updated.ruleArn).toBe(rule.ruleArn);

      const afterUpdate = yield* findRule(rule.ruleName);
      expect(afterUpdate?.Priority).toBe(8000);
      expect(afterUpdate?.FixedRate).toBe(0.1);
      expect(afterUpdate?.ReservoirSize).toBe(2);
      expect(afterUpdate?.HTTPMethod).toBe("GET");
      expect(afterUpdate?.Attributes).toEqual({ tier: "premium" });
      const updatedTags = yield* xray
        .listTagsForResource({ ResourceARN: rule.ruleArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(updatedTags.Extra).toBe("1");

      // remove a tag — converges via untagResource
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SamplingRule("TestRule", {
            priority: 8000,
            fixedRate: 0.1,
            reservoirSize: 2,
            serviceName: "alchemy-xray-test-*",
            httpMethod: "GET",
            attributes: { tier: "premium" },
            tags: { Environment: "test" },
          });
        }),
      );
      const afterTagRemoval = yield* xray
        .listTagsForResource({ ResourceARN: rule.ruleArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(afterTagRemoval.Extra).toBeUndefined();
      expect(afterTagRemoval.Environment).toBe("test");

      yield* stack.destroy();
      yield* assertRuleDeleted(rule.ruleName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom rule name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SamplingRule("NamedRule", {
            ruleName: "alchemy-test-rule-a",
            priority: 9100,
            fixedRate: 0.01,
          });
        }),
      );
      expect(first.ruleName).toBe("alchemy-test-rule-a");
      expect(first.ruleArn).toContain(":sampling-rule/alchemy-test-rule-a");

      // renaming triggers a replacement: new physical rule, old one gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SamplingRule("NamedRule", {
            ruleName: "alchemy-test-rule-b",
            priority: 9100,
            fixedRate: 0.01,
          });
        }),
      );
      expect(second.ruleName).toBe("alchemy-test-rule-b");

      const observed = yield* findRule("alchemy-test-rule-b");
      expect(observed?.Priority).toBe(9100);
      yield* assertRuleDeleted("alchemy-test-rule-a");

      yield* stack.destroy();
      yield* assertRuleDeleted("alchemy-test-rule-b");
    }),
  { timeout: 120_000 },
);
