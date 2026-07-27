import * as AWS from "@/AWS";
import { Rule } from "@/AWS/Rbin";
import * as Test from "@/Test/Alchemy";
import * as rbin from "@distilled.cloud/aws/rbin";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

/** Typed wait-until-gone: getRule must settle on RULE_NOT_FOUND. */
const assertRuleGone = (identifier: string) =>
  rbin.getRule({ Identifier: identifier }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`retention rule ${identifier} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe("AWS.Rbin.Rule", () => {
  test.provider(
    "lifecycle: create, update in place, replace on resourceType, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Create a tag-level rule (scoped by resourceTags so it never
        // retains other test suites' deleted snapshots).
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const rule = yield* Rule("SnapshotRetention", {
              resourceType: "EBS_SNAPSHOT",
              retentionPeriod: "7 days",
              description: "alchemy rbin lifecycle test",
              resourceTags: [{ key: "alchemy-rbin-test", value: "snapshots" }],
              tags: { purpose: "alchemy-test" },
            });
            return {
              identifier: rule.identifier,
              ruleArn: rule.ruleArn,
            };
          }),
        );

        // Out-of-band verification via distilled.
        const observed = yield* rbin.getRule({
          Identifier: created.identifier,
        });
        expect(observed.RuleArn).toEqual(created.ruleArn);
        expect(observed.ResourceType).toEqual("EBS_SNAPSHOT");
        expect(observed.RetentionPeriod).toEqual({
          RetentionPeriodValue: 7,
          RetentionPeriodUnit: "DAYS",
        });
        expect(observed.Description).toEqual("alchemy rbin lifecycle test");
        expect(observed.ResourceTags).toEqual([
          {
            ResourceTagKey: "alchemy-rbin-test",
            ResourceTagValue: "snapshots",
          },
        ]);
        expect(observed.Status).toEqual("available");

        const tags = yield* rbin.listTagsForResource({
          ResourceArn: created.ruleArn,
        });
        expect(tags.Tags).toEqual(
          expect.arrayContaining([
            { Key: "purpose", Value: "alchemy-test" },
            { Key: "alchemy::id", Value: "SnapshotRetention" },
          ]),
        );

        // Update in place: retention period, description, resource tags,
        // and rule tags (remove `purpose`, add `owner`).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const rule = yield* Rule("SnapshotRetention", {
              resourceType: "EBS_SNAPSHOT",
              retentionPeriod: "14 days",
              description: "alchemy rbin lifecycle test (updated)",
              resourceTags: [{ key: "alchemy-rbin-test", value: "updated" }],
              tags: { owner: "alchemy" },
            });
            return { identifier: rule.identifier, ruleArn: rule.ruleArn };
          }),
        );
        expect(updated.identifier).toEqual(created.identifier);

        const observedUpdated = yield* rbin.getRule({
          Identifier: updated.identifier,
        });
        expect(observedUpdated.RetentionPeriod?.RetentionPeriodValue).toEqual(
          14,
        );
        expect(observedUpdated.Description).toEqual(
          "alchemy rbin lifecycle test (updated)",
        );
        expect(observedUpdated.ResourceTags).toEqual([
          { ResourceTagKey: "alchemy-rbin-test", ResourceTagValue: "updated" },
        ]);

        const updatedTags = yield* rbin.listTagsForResource({
          ResourceArn: updated.ruleArn,
        });
        expect(updatedTags.Tags).toEqual(
          expect.arrayContaining([{ Key: "owner", Value: "alchemy" }]),
        );
        expect(updatedTags.Tags).not.toEqual(
          expect.arrayContaining([{ Key: "purpose", Value: "alchemy-test" }]),
        );

        // Replacement: changing the resource type replaces the rule.
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const rule = yield* Rule("SnapshotRetention", {
              resourceType: "EC2_IMAGE",
              retentionPeriod: "14 days",
              description: "alchemy rbin lifecycle test (updated)",
              resourceTags: [{ key: "alchemy-rbin-test", value: "updated" }],
              tags: { owner: "alchemy" },
            });
            return { identifier: rule.identifier, ruleArn: rule.ruleArn };
          }),
        );
        expect(replaced.identifier).not.toEqual(created.identifier);

        const observedReplaced = yield* rbin.getRule({
          Identifier: replaced.identifier,
        });
        expect(observedReplaced.ResourceType).toEqual("EC2_IMAGE");
        // The replaced (old) rule is deleted after the new one lands.
        yield* assertRuleGone(created.identifier);

        yield* stack.destroy();
        yield* assertRuleGone(replaced.identifier);
      }),
    { timeout: 180_000 },
  );
});
