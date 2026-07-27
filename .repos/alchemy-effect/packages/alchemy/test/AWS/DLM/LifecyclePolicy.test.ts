import * as AWS from "@/AWS";
import { LifecyclePolicy, type LifecyclePolicyDetails } from "@/AWS/DLM";
import * as IAM from "@/AWS/IAM";
import * as Test from "@/Test/Alchemy";
import * as dlm from "@distilled.cloud/aws/dlm";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class PolicyStillExists extends Data.TaggedError("PolicyStillExists")<{
  readonly policyId: string;
}> {}

const assertPolicyDeleted = (policyId: string) =>
  dlm.getLifecyclePolicy({ PolicyId: policyId }).pipe(
    Effect.flatMap(() => Effect.fail(new PolicyStillExists({ policyId }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PolicyStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

class RoleStillExists extends Data.TaggedError("RoleStillExists")<{
  readonly roleName: string;
}> {}

const assertRoleDeleted = (roleName: string) =>
  iam.getRole({ RoleName: roleName }).pipe(
    Effect.flatMap(() => Effect.fail(new RoleStillExists({ roleName }))),
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RoleStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const tagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string | undefined> => tags ?? {};

const snapshotDetails = (retainCount: number) =>
  ({
    resourceTypes: ["VOLUME"],
    targetTags: { AlchemyDlmTest: "true" },
    schedules: [
      {
        name: "Daily",
        copyTags: false,
        createRule: {
          interval: 24,
          intervalUnit: "HOURS",
          times: ["03:00"],
        },
        retainRule: { count: retainCount },
      },
    ],
  }) satisfies LifecyclePolicyDetails;

test.provider(
  "create, update, no-op, tag removal, destroy with managed role",
  (stack) =>
    Effect.gen(function* () {
      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LifecyclePolicy("Snapshots", {
            policyDetails: snapshotDetails(7),
            tags: { Environment: "test" },
          });
        }),
      );

      expect(policy.policyId).toMatch(/^policy-/);
      expect(policy.policyArn).toContain(":policy/");
      expect(policy.state).toBe("ENABLED");
      expect(policy.executionRoleArn).toContain(":role/");
      expect(policy.roleName).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* dlm
        .getLifecyclePolicy({ PolicyId: policy.policyId })
        .pipe(Effect.map((r) => r.Policy!));
      expect(created.State).toBe("ENABLED");
      expect(created.ExecutionRoleArn).toBe(policy.executionRoleArn);
      expect(created.PolicyDetails?.PolicyType).toBe("EBS_SNAPSHOT_MANAGEMENT");
      expect(created.PolicyDetails?.ResourceTypes).toEqual(["VOLUME"]);
      expect(created.PolicyDetails?.TargetTags).toEqual([
        { Key: "AlchemyDlmTest", Value: "true" },
      ]);
      expect(created.PolicyDetails?.Schedules?.[0]?.RetainRule?.Count).toBe(7);
      const createdTags = tagRecord(created.Tags);
      expect(createdTags.Environment).toBe("test");
      expect(createdTags["alchemy::id"]).toBe("Snapshots");

      // update retention + state + add a tag — same physical policy
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LifecyclePolicy("Snapshots", {
            state: "DISABLED",
            policyDetails: snapshotDetails(14),
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.policyId).toBe(policy.policyId);
      expect(updated.state).toBe("DISABLED");

      const afterUpdate = yield* dlm
        .getLifecyclePolicy({ PolicyId: policy.policyId })
        .pipe(Effect.map((r) => r.Policy!));
      expect(afterUpdate.State).toBe("DISABLED");
      expect(afterUpdate.PolicyDetails?.Schedules?.[0]?.RetainRule?.Count).toBe(
        14,
      );
      expect(tagRecord(afterUpdate.Tags).Extra).toBe("1");
      const modifiedAfterUpdate = afterUpdate.DateModified?.toISOString();

      // no-op deploy converges without issuing an update
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LifecyclePolicy("Snapshots", {
            state: "DISABLED",
            policyDetails: snapshotDetails(14),
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const afterNoop = yield* dlm
        .getLifecyclePolicy({ PolicyId: policy.policyId })
        .pipe(Effect.map((r) => r.Policy!));
      expect(afterNoop.DateModified?.toISOString()).toBe(modifiedAfterUpdate);

      // remove a tag
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LifecyclePolicy("Snapshots", {
            state: "DISABLED",
            policyDetails: snapshotDetails(14),
            tags: { Environment: "test" },
          });
        }),
      );
      const afterTagRemoval = yield* dlm
        .getLifecyclePolicy({ PolicyId: policy.policyId })
        .pipe(Effect.map((r) => tagRecord(r.Policy?.Tags)));
      expect(afterTagRemoval.Extra).toBeUndefined();
      expect(afterTagRemoval.Environment).toBe("test");
      expect(afterTagRemoval["alchemy::id"]).toBe("Snapshots");

      yield* stack.destroy();
      yield* assertPolicyDeleted(policy.policyId);
      yield* assertRoleDeleted(policy.roleName!);
    }),
  { timeout: 120_000 },
);

test.provider(
  "explicit execution role; policy type change triggers replacement",
  (stack) =>
    Effect.gen(function* () {
      const deployWith = (policyDetails: LifecyclePolicyDetails) =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* IAM.Role("DlmRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "dlm.amazonaws.com" },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
                "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRoleForAMIManagement",
              ],
            });
            const policy = yield* LifecyclePolicy("Policy", {
              description: "alchemy dlm explicit role test",
              state: "DISABLED",
              executionRoleArn: role.roleArn,
              policyDetails,
            });
            return { role, policy };
          }),
        );

      const first = yield* deployWith(snapshotDetails(2));
      expect(first.policy.state).toBe("DISABLED");
      expect(first.policy.roleName).toBeUndefined();
      expect(first.policy.executionRoleArn).toBe(first.role.roleArn);

      const observed = yield* dlm
        .getLifecyclePolicy({ PolicyId: first.policy.policyId })
        .pipe(Effect.map((r) => r.Policy!));
      expect(observed.State).toBe("DISABLED");
      expect(observed.Description).toBe("alchemy dlm explicit role test");
      expect(observed.ExecutionRoleArn).toBe(first.role.roleArn);

      // changing the policy type replaces the policy (new PolicyId). The
      // role stays deployed across the replacement step.
      const second = yield* deployWith({
        policyType: "IMAGE_MANAGEMENT",
        resourceTypes: ["INSTANCE"],
        targetTags: { AlchemyDlmTest: "ami" },
        parameters: { noReboot: true },
        schedules: [
          {
            name: "Nightly",
            createRule: { interval: 24, intervalUnit: "HOURS" },
            retainRule: { count: 2 },
          },
        ],
      });
      expect(second.policy.policyId).not.toBe(first.policy.policyId);

      const observedAmi = yield* dlm
        .getLifecyclePolicy({ PolicyId: second.policy.policyId })
        .pipe(Effect.map((r) => r.Policy!));
      expect(observedAmi.PolicyDetails?.PolicyType).toBe("IMAGE_MANAGEMENT");
      expect(observedAmi.PolicyDetails?.Parameters?.NoReboot).toBe(true);
      yield* assertPolicyDeleted(first.policy.policyId);

      yield* stack.destroy();
      yield* assertPolicyDeleted(second.policy.policyId);
    }),
  { timeout: 180_000 },
);
