import * as AWS from "@/AWS";
import { InvestigationGroup } from "@/AWS/AIOps";
import type { PolicyStatement } from "@/AWS/IAM/Policy.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as aiops from "@distilled.cloud/aws/aiops";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getInvestigationGroup on a nonexistent group fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        aiops.getInvestigationGroup({
          identifier: "nonexistent0000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const findGroup = (arn: string) =>
  aiops
    .getInvestigationGroup({ identifier: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

class GroupStillExists extends Data.TaggedError("GroupStillExists")<{
  readonly arn: string;
}> {}

const assertGroupDeleted = (arn: string) =>
  findGroup(arn).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new GroupStillExists({ arn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "GroupStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// An account can hold only ONE investigation group per Region, so the live
// lifecycle would collide with any pre-existing group (or a concurrent CI
// run). Gated behind AWS_TEST_AIOPS=1; always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_AIOPS)(
  "create, update, replace (delete-first), delete investigation group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployGroup = (props: {
        retention: Duration.Input;
        tagKeyBoundaries: string[];
        isCloudTrailEventHistoryEnabled?: boolean;
        policy?: PolicyStatement[];
        tags: Record<string, string>;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* Role("AIOpsRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "aiops.amazonaws.com" },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/AIOpsAssistantPolicy",
              ],
            });
            const group = yield* InvestigationGroup("Investigations", {
              roleArn: role.roleArn,
              ...props,
            });
            return { group };
          }),
        );

      const { group } = yield* deployGroup({
        retention: "7 days",
        tagKeyBoundaries: ["Application"],
        tags: { Environment: "test" },
      });

      expect(group.name).toBeDefined();
      expect(group.arn).toContain(":investigation-group/");
      expect(group.retentionInDays).toBe(7);

      // Out-of-band verification via distilled.
      const created = yield* findGroup(group.arn);
      expect(created?.name).toBe(group.name);
      expect(created?.retentionInDays).toBe(7);
      expect(created?.tagKeyBoundaries).toEqual(["Application"]);
      const tags = yield* aiops
        .listTagsForResource({ resourceArn: group.arn })
        .pipe(Effect.map((r) => r.tags ?? {}));
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("Investigations");

      // Update mutable aspects in place: tag key boundaries, CloudTrail
      // event history, resource policy, and tags.
      const alarmPolicyStatement: PolicyStatement = {
        Effect: "Allow",
        Principal: { Service: "aiops.alarms.cloudwatch.amazonaws.com" },
        Action: ["aiops:CreateInvestigation", "aiops:CreateInvestigationEvent"],
        Resource: "*",
      };
      const { group: updated } = yield* deployGroup({
        retention: "7 days",
        tagKeyBoundaries: ["Application", "Service"],
        isCloudTrailEventHistoryEnabled: false,
        policy: [alarmPolicyStatement],
        tags: { Environment: "test", Team: "obs" },
      });
      expect(updated.arn).toBe(group.arn);

      const afterUpdate = yield* findGroup(group.arn);
      expect(afterUpdate?.tagKeyBoundaries).toEqual(["Application", "Service"]);
      expect(afterUpdate?.isCloudTrailEventHistoryEnabled).toBe(false);
      const updatedTags = yield* aiops
        .listTagsForResource({ resourceArn: group.arn })
        .pipe(Effect.map((r) => r.tags ?? {}));
      expect(updatedTags.Team).toBe("obs");

      // Out-of-band: the resource policy landed on the group.
      const policyAfterUpdate = yield* aiops.getInvestigationGroupPolicy({
        identifier: group.arn,
      });
      expect(
        JSON.parse(policyAfterUpdate.policy ?? "{}").Statement,
      ).toMatchObject([alarmPolicyStatement]);

      // `policy: []` deletes the attached resource policy.
      yield* deployGroup({
        retention: "7 days",
        tagKeyBoundaries: ["Application", "Service"],
        isCloudTrailEventHistoryEnabled: false,
        policy: [],
        tags: { Environment: "test", Team: "obs" },
      });
      const policyAfterDelete = yield* aiops
        .getInvestigationGroupPolicy({ identifier: group.arn })
        .pipe(
          Effect.map((r) => r.policy),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(policyAfterDelete).toBeUndefined();

      // The retention period has no update API — changing it replaces the
      // group (delete-first, because only one group may exist per Region).
      const { group: replaced } = yield* deployGroup({
        retention: "14 days",
        tagKeyBoundaries: ["Application", "Service"],
        isCloudTrailEventHistoryEnabled: false,
        tags: { Environment: "test", Team: "obs" },
      });
      expect(replaced.arn).not.toBe(group.arn);
      expect(replaced.retentionInDays).toBe(14);
      const afterReplace = yield* findGroup(replaced.arn);
      expect(afterReplace?.retentionInDays).toBe(14);
      yield* assertGroupDeleted(group.arn);

      yield* stack.destroy();
      yield* assertGroupDeleted(replaced.arn);
    }),
  { timeout: 600_000 },
);
