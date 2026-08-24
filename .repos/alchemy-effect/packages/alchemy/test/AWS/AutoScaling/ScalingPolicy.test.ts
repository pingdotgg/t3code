import * as AWS from "@/AWS";
import {
  AutoScalingGroup,
  LaunchTemplate,
  ScalingPolicy,
} from "@/AWS/AutoScaling";
import { amazonLinux2023, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getAutoScalingTestSubnetId } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Out-of-band proof a scaling policy is deleted: describePolicies by name
// returns an empty list once the policy (or its group) is gone.
const assertPolicyGone = (policyName: string) =>
  autoscaling.describePolicies({ PolicyNames: [policyName] }).pipe(
    Effect.map((r) => (r.ScalingPolicies ?? []).length),
    Effect.repeat({
      until: (count) => count === 0,
      schedule: Schedule.spaced("2 seconds"),
      times: 8,
    }),
    Effect.map((count) => expect(count).toBe(0)),
  );

// Out-of-band proof an Auto Scaling Group is deleted after the trailing
// stack.destroy(): the name-filtered describe returns an empty list.
const assertGroupGone = (name: string) =>
  autoscaling
    .describeAutoScalingGroups({ AutoScalingGroupNames: [name] } as any)
    .pipe(
      Effect.map((r) => (r.AutoScalingGroups ?? []).length),
      Effect.repeat({
        until: (count) => count === 0,
        schedule: Schedule.spaced("3 seconds"),
        times: 10,
      }),
      Effect.map((count) => expect(count).toBe(0)),
    );

// `list()` enumerates every scaling policy in the account/region via the
// paginated `autoscaling.describePolicies` op (no AutoScalingGroupName filter,
// so it spans every group). Deploy a real ASG (sized to zero so no EC2
// instances launch) with a target-tracking policy, resolve the provider from
// context via the typed `findProvider`, call `list()`, and assert the deployed
// policy appears in the exhaustively paginated result.
test.provider(
  "list enumerates the deployed scaling policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back to
      // a syntactically valid id if the lookup returns nothing.
      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("TestVpc", { cidrBlock: "10.0.0.0/16" });
          const subnet = yield* Subnet("TestSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
          });
          const template = yield* LaunchTemplate("ListPolicyTemplate", {
            launchTemplateName: "alchemy-test-policy-lt-list",
            imageId,
            instanceType: "t3.micro",
          });
          const group = yield* AutoScalingGroup("ListPolicyGroup", {
            autoScalingGroupName: "alchemy-test-policy-asg-list",
            launchTemplate: template,
            subnetIds: [subnet.subnetId],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
          });
          return yield* ScalingPolicy("ListScalingPolicy", {
            policyName: "alchemy-test-scaling-policy-list",
            autoScalingGroup: group,
            predefinedMetricType: "ASGAverageCPUUtilization",
            targetValue: 50,
          });
        }),
      );

      const provider = yield* Provider.findProvider(ScalingPolicy);
      const all = yield* provider.list();

      expect(all.some((p) => p.policyName === policy.policyName)).toBe(true);

      yield* stack.destroy();
      yield* assertPolicyGone(policy.policyName);
      yield* assertGroupGone("alchemy-test-policy-asg-list");
    }),
  { timeout: 240_000 },
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the scaling policy as
// `status: "creating"` with no attributes — and the Output-valued
// `autoScalingGroup` prop (a whole AutoScalingGroup resource object) does not
// survive the state round-trip: it deserializes as `undefined`. Plan's
// recovery branches then hand those junk props back to the provider as
// `olds`:
//
// - `read` must tolerate `olds.autoScalingGroup === undefined` and fall back
//   to an account-wide `describePolicies` lookup by (unique physical) policy
//   name, so a half-created policy that DOES exist is recovered in place
//   (same policyArn, no duplicate).
// - `diff` must NOT treat "old ASG name unknown vs new ASG name known" as an
//   ASG change: pre-fix it forced `action: "replace"`, which mints a new
//   instanceId and therefore a NEW generated policy name instead of resuming
//   the same create.
//
// The launch template is created out-of-band via distilled `ec2` (not the
// `AWS.AutoScaling.LaunchTemplate` resource) to isolate this test from that
// provider's unrelated untyped-NotFound read bug. The fleet is placed into a
// subnet of the account's default VPC (resolved out-of-band) rather than a
// throwaway `Vpc` resource: a failed run of this test loses its in-memory
// scratch state, and orphaned VPCs quickly exhaust the 5-per-region quota.
const recoveryLtName = "alchemy-test-scaling-policy-recovery-lt";
const recoveryAsgName = "alchemy-test-scaling-policy-recovery-asg";
const cleanupRecoveryLt = ec2
  .deleteLaunchTemplate({ LaunchTemplateName: recoveryLtName } as any)
  .pipe(Effect.catch(() => Effect.void));
// Leftover-cleanup for interrupted/failed prior runs (the ASG name is
// deterministic and account-unique; deleting it also deletes its policies).
const cleanupRecoveryAsg = autoscaling
  .deleteAutoScalingGroup({
    AutoScalingGroupName: recoveryAsgName,
    ForceDelete: true,
  } as any)
  .pipe(Effect.catch(() => Effect.void));

test.provider(
  "recovers a half-created scaling policy whose creating-state lost the Output-valued autoScalingGroup (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanupRecoveryAsg;
      yield* cleanupRecoveryLt;
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back
      // to a syntactically valid id if the lookup returns nothing.
      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";
      yield* ec2.createLaunchTemplate({
        LaunchTemplateName: recoveryLtName,
        LaunchTemplateData: { ImageId: imageId, InstanceType: "t3.micro" },
      } as any);

      const subnetId = yield* getAutoScalingTestSubnetId;

      const deployPolicy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* AutoScalingGroup("RecoveryGroup", {
              autoScalingGroupName: recoveryAsgName,
              launchTemplate: { launchTemplateName: recoveryLtName },
              subnetIds: [subnetId],
              minSize: 0,
              maxSize: 0,
              desiredCapacity: 0,
            });
            return yield* ScalingPolicy("RecoveryScalingPolicy", {
              // Whole-resource spelling — the #736 shape (an unresolved
              // Output persisted at `creating` does not survive the state
              // round-trip) AND coverage for the resolved-attributes
              // narrowing: the engine resolves `group` to its bare
              // Attributes record (no resource `Type` marker), which the
              // provider must narrow by shape (`autoScalingGroupName`
              // string field) to extract the group name.
              // policyName intentionally omitted: the engine-generated
              // physical name embeds the instanceId, so a wrongful
              // `replace` (pre-fix diff) is observable as a changed name.
              autoScalingGroup: group,
              predefinedMetricType: "ASGAverageCPUUtilization",
              targetValue: 50,
              // Duration.Input prop — whole seconds on the wire.
              estimatedInstanceWarmup: "90 seconds",
            });
          }),
        );

      const created = yield* deployPolicy();

      // Duration.Input round-trips to the wire as whole seconds.
      const liveCreated = yield* autoscaling.describePolicies({
        PolicyNames: [created.policyName],
      });
      expect(liveCreated.ScalingPolicies?.[0]?.EstimatedInstanceWarmup).toEqual(
        90,
      );

      // Rewrite the policy's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and the
      // Output-valued `autoScalingGroup` lost in the round-trip.
      const wedgeRow = Effect.gen(function* () {
        const state = yield* yield* State;
        const stage = "test"; // scratch stacks default to the "test" stage
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state
            .get({ stack: stack.name, stage, fqn })
            .pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) &&
            r.row.resourceType === "AWS.AutoScaling.ScalingPolicy",
        );
        if (!wedged) {
          return yield* Effect.die(
            new Error(
              "no AWS.AutoScaling.ScalingPolicy state row found after deploy",
            ),
          );
        }
        yield* state.set({
          stack: stack.name,
          stage,
          fqn: wedged.fqn,
          value: {
            ...wedged.row,
            status: "creating",
            attr: undefined,
            props: {
              ...wedged.row.props,
              autoScalingGroup: undefined,
            },
          },
        });
      });

      // Variant A — the half-created policy still exists in the cloud.
      // `read` gets junk olds (no ASG name) and must find the policy via the
      // account-wide name-only lookup: SAME policyArn, no duplicate.
      yield* wedgeRow;
      const recoveredInPlace = yield* deployPolicy();
      expect(recoveredInPlace.policyArn).toEqual(created.policyArn);
      expect(recoveredInPlace.policyName).toEqual(created.policyName);
      expect(recoveredInPlace.autoScalingGroupName).toEqual(
        created.autoScalingGroupName,
      );

      // Variant B — wedge again AND delete the policy out-of-band so the
      // recovery `read` misses and `diff` runs with the junk olds. Pre-fix,
      // diff saw `undefined !== <asg name>` and forced a replacement (new
      // instanceId => new generated policy name). Post-fix it falls through
      // to update, resumes the same create, and recreates under the SAME
      // name.
      yield* wedgeRow;
      yield* autoscaling.deletePolicy({
        AutoScalingGroupName: created.autoScalingGroupName,
        PolicyName: created.policyName,
      } as any);
      const remaining = yield* autoscaling
        .describePolicies({ PolicyNames: [created.policyName] })
        .pipe(
          Effect.map((result) => (result.ScalingPolicies ?? []).length),
          Effect.repeat({
            until: (count) => count === 0,
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
        );
      expect(remaining).toBe(0);

      const recreated = yield* deployPolicy();
      expect(recreated.policyName).toEqual(created.policyName);
      expect(recreated.autoScalingGroupName).toEqual(
        created.autoScalingGroupName,
      );

      // Out-of-band proof the policy is live again.
      const after = yield* autoscaling.describePolicies({
        PolicyNames: [created.policyName],
      });
      expect(
        (after.ScalingPolicies ?? []).some(
          (p) => p.PolicyName === created.policyName,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertPolicyGone(created.policyName);
      yield* assertGroupGone(recoveryAsgName);
      yield* cleanupRecoveryLt;
    }).pipe(Effect.ensuring(cleanupRecoveryLt)),
  { timeout: 240_000 },
);
