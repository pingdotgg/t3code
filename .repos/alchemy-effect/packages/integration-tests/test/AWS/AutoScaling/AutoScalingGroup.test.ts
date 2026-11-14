import * as AWS from "@alchemy.run/aws";
import { AutoScalingGroup, LaunchTemplate } from "@alchemy.run/aws/AutoScaling";
import { amazonLinux2023, Subnet, Vpc } from "@alchemy.run/aws/EC2";
import { InstanceProfile, Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getAutoScalingTestSubnetId, getTestAmiId } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Out-of-band proof that an Auto Scaling Group is fully deleted after the
// trailing stack.destroy(): describeAutoScalingGroups with a name filter
// returns an empty list once deletion completes (bounded poll — the provider's
// delete already waits, this is a cheap final confirmation).
const assertGroupGone = (name: string) =>
  autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: [name] } as any).pipe(
    Effect.map((r) => (r.AutoScalingGroups ?? []).length),
    Effect.repeat({
      until: (count) => count === 0,
      schedule: Schedule.spaced("3 seconds"),
      times: 10,
    }),
    Effect.map((count) => expect(count).toBe(0)),
  );

const launchTemplateName = "alchemy-test-asg-lt-oob";

// The launch template is created out-of-band via distilled `ec2` rather than the
// `AWS.AutoScaling.LaunchTemplate` resource: that resource's read-before-create
// path currently dies on an untyped `ec2` NotFound (`describeLaunchTemplates`
// does not declare `InvalidLaunchTemplateName.NotFoundException`), which is a gap
// in a different provider. Creating the template directly isolates this test to
// the ASG `list()` operation under test.
const cleanupLaunchTemplate = ec2
  .deleteLaunchTemplate({ LaunchTemplateName: launchTemplateName } as any)
  .pipe(Effect.catch(() => Effect.void));

// `list()` enumerates every Auto Scaling Group in the account/region via the
// paginated `autoscaling.describeAutoScalingGroups` op. Deploy a real ASG (sized
// to zero so no EC2 instances launch), resolve the provider from context via the
// typed `findProvider`, call `list()`, and assert the deployed group appears in
// the exhaustively paginated result.
test.provider(
  "list enumerates the deployed auto scaling group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The launch template is created out-of-band with the raw SDK, so the
      // AMI id must be a plain string — `amazonLinux2023()` returns an
      // Output, which only resolves inside `stack.deploy`.
      const imageId = yield* getTestAmiId;

      yield* cleanupLaunchTemplate;
      yield* ec2.createLaunchTemplate({
        LaunchTemplateName: launchTemplateName,
        LaunchTemplateData: { ImageId: imageId, InstanceType: "t3.micro" },
      } as any);

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("TestVpc", { cidrBlock: "10.0.0.0/16" });
          const subnet = yield* Subnet("TestSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
          });
          return yield* AutoScalingGroup("ListAutoScalingGroup", {
            autoScalingGroupName: "alchemy-test-asg-list",
            launchTemplate: { launchTemplateName },
            subnetIds: [subnet.subnetId],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
          });
        }),
      );

      const provider = yield* Provider.findProvider(AutoScalingGroup);
      const all = yield* provider.list();

      expect(all.some((g) => g.autoScalingGroupName === group.autoScalingGroupName)).toBe(true);

      yield* stack.destroy();
      yield* assertGroupGone("alchemy-test-asg-list");
    }).pipe(Effect.ensuring(cleanupLaunchTemplate)),
  {
    tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ec2", "live"],
    timeout: 240_000,
  },
);

// Whole-resource `launchTemplate: template` spelling. The engine resolves the
// resource reference to its bare Attributes record before it reaches the
// provider — no resource `Type` marker survives — so `toLaunchTemplateSpec`
// must narrow on the attributes shape. Pre-fix it fell through to the
// reference branch, which sent BOTH LaunchTemplateId and LaunchTemplateName
// to `createAutoScalingGroup` (AWS rejects a spec carrying both) with the
// version defaulted to `$Default` instead of the template's resolved default
// version.
//
// The fleet is placed into a subnet of the account's default VPC (resolved
// out-of-band) rather than a throwaway `Vpc` resource: a failed run loses its
// in-memory scratch state, and orphaned VPCs quickly exhaust the 5-per-region
// quota.
const wholeAsgName = "alchemy-test-asg-whole-lt";
const cleanupWholeAsg = autoscaling
  .deleteAutoScalingGroup({
    AutoScalingGroupName: wholeAsgName,
    ForceDelete: true,
  } as any)
  .pipe(Effect.catch(() => Effect.void));

test.provider(
  "wires a whole LaunchTemplate resource by id and pinned default version",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanupWholeAsg;
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back
      // to a syntactically valid id if the lookup returns nothing.
      const imageId = amazonLinux2023();

      const subnetId = yield* getAutoScalingTestSubnetId;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* LaunchTemplate("WholeLtTemplate", {
            imageId,
            instanceType: "t3.micro",
          });
          const group = yield* AutoScalingGroup("WholeLtGroup", {
            autoScalingGroupName: wholeAsgName,
            // Whole resource — resolves to bare Attributes at deploy time.
            launchTemplate: template,
            subnetIds: [subnetId],
            minSize: 0,
            maxSize: 0,
            desiredCapacity: 0,
            // Duration.Input props — whole seconds on the wire.
            defaultCooldown: "45 seconds",
            healthCheckGracePeriod: "2 minutes",
          });
          return {
            templateId: template.launchTemplateId.as<string>(),
            templateDefaultVersion: template.defaultVersionNumber.as<number>(),
            group,
          };
        }),
      );

      // The group is wired to the template by ID with the version pinned to
      // the template's resolved default version (not "$Default").
      expect(deployed.group.launchTemplateId).toEqual(deployed.templateId);
      expect(deployed.group.launchTemplateVersion).toEqual(String(deployed.templateDefaultVersion));

      // Duration.Input props round-trip as whole seconds in the attributes.
      expect(deployed.group.defaultCooldown).toEqual(45);
      expect(deployed.group.healthCheckGracePeriod).toEqual(120);

      // Out-of-band: the live group carries the id-only spec and the
      // Duration-derived second counts on the wire.
      const described = yield* autoscaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [wholeAsgName],
      } as any);
      const live = described.AutoScalingGroups?.[0];
      expect(live?.LaunchTemplate?.LaunchTemplateId).toEqual(deployed.templateId);
      expect(live?.DefaultCooldown).toEqual(45);
      expect(live?.HealthCheckGracePeriod).toEqual(120);

      yield* stack.destroy();
      yield* assertGroupGone(wholeAsgName);
    }).pipe(Effect.ensuring(cleanupWholeAsg)),
  {
    tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ec2", "live"],
    timeout: 240_000,
  },
);

// An omitted `desiredCapacity` belongs to whoever scales the group (ECS
// managed scaling, a scaling policy): redeploys must not reset it to
// `minSize`. The launch template names an instance profile created in the
// same deploy, which IAM may not have propagated yet (`InvalidIamInstanceProfile`
// is retried). `Launch` is suspended before scaling out so no instance starts.
test.provider(
  "keeps an externally scaled desired capacity across redeploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subnetId = yield* getAutoScalingTestSubnetId;

      const program = (maxSize: number) =>
        Effect.gen(function* () {
          const role = yield* Role("ScaledGroupRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "ec2.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          const profile = yield* InstanceProfile("ScaledGroupProfile", {
            roleName: role.roleName,
          });
          const template = yield* LaunchTemplate("ScaledGroupTemplate", {
            imageId: amazonLinux2023(),
            instanceType: "t3.micro",
            instanceProfileName: profile.instanceProfileName,
          });
          return yield* AutoScalingGroup("ScaledGroup", {
            launchTemplate: template,
            subnetIds: [subnetId],
            minSize: 0,
            maxSize,
          });
        });

      const describe = (name: string) =>
        autoscaling
          .describeAutoScalingGroups({ AutoScalingGroupNames: [name] } as any)
          .pipe(Effect.map((r) => r.AutoScalingGroups?.[0]));

      const created = yield* stack.deploy(program(1));
      const name = created.autoScalingGroupName;
      expect((yield* describe(name))?.DesiredCapacity).toBe(0);

      // An external scaler raises the desired capacity.
      yield* autoscaling.suspendProcesses({
        AutoScalingGroupName: name,
        ScalingProcesses: ["Launch"],
      } as any);
      yield* autoscaling.setDesiredCapacity({
        AutoScalingGroupName: name,
        DesiredCapacity: 1,
      } as any);

      // A redeploy that updates the group leaves the live value alone.
      yield* stack.deploy(program(2));
      const live = yield* describe(name);
      expect(live?.MaxSize).toBe(2);
      expect(live?.DesiredCapacity).toBe(1);

      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:autoscaling",
      "provider:aws:ec2",
      "provider:aws:iam",
      "live",
    ],
    timeout: 300_000,
  },
);

// `instanceRequirements` moves the launch template into a mixed instances
// policy with one attribute-based override; dropping it switches the group
// back to the plain launch template, and adding it again switches back.
// `availabilityZoneDistribution` is diffed against the live group and resets
// to the AWS default when removed. The group stays at zero capacity, so no
// instance launches.
test.provider(
  "switches between instance requirements and a plain launch template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subnetId = yield* getAutoScalingTestSubnetId;

      const instanceRequirements = {
        VCpuCount: { Min: 1, Max: 2 },
        MemoryMiB: { Min: 512, Max: 4096 },
        BurstablePerformance: "required",
      } as const;

      const program = (mixed: boolean) =>
        Effect.gen(function* () {
          const template = yield* LaunchTemplate("RequirementsTemplate", {
            imageId: amazonLinux2023(),
            instanceType: "t3.micro",
          });
          return yield* AutoScalingGroup("RequirementsGroup", {
            launchTemplate: template,
            subnetIds: [subnetId],
            minSize: 0,
            maxSize: 1,
            desiredCapacity: 0,
            ...(mixed
              ? {
                  instanceRequirements,
                  availabilityZoneDistribution: {
                    CapacityDistributionStrategy: "balanced-only",
                  },
                }
              : {}),
          });
        });

      const describe = (name: string) =>
        autoscaling
          .describeAutoScalingGroups({ AutoScalingGroupNames: [name] })
          .pipe(Effect.map((r) => r.AutoScalingGroups?.[0]));

      const expectMixed = Effect.fn(function* (group: AutoScalingGroup["Attributes"]) {
        expect(group.instanceRequirements?.VCpuCount).toEqual({ Min: 1, Max: 2 });
        expect(group.instanceRequirements?.BurstablePerformance).toEqual("required");
        expect(group.availabilityZoneDistribution?.CapacityDistributionStrategy).toEqual(
          "balanced-only",
        );
        expect(group.launchTemplateId).toMatch(/^lt-/);

        const live = yield* describe(group.autoScalingGroupName);
        expect(live?.LaunchTemplate).toBeUndefined();
        const mixedTemplate = live?.MixedInstancesPolicy?.LaunchTemplate;
        expect(mixedTemplate?.LaunchTemplateSpecification?.LaunchTemplateId).toEqual(
          group.launchTemplateId,
        );
        expect(mixedTemplate?.Overrides?.[0]?.InstanceRequirements?.VCpuCount).toEqual({
          Min: 1,
          Max: 2,
        });
        expect(mixedTemplate?.Overrides?.[0]?.InstanceRequirements?.MemoryMiB).toEqual({
          Min: 512,
          Max: 4096,
        });
        expect(live?.AvailabilityZoneDistribution?.CapacityDistributionStrategy).toEqual(
          "balanced-only",
        );
      });

      const created = yield* stack.deploy(program(true));
      yield* expectMixed(created);

      // An unchanged redeploy plans no update.
      const unchanged = yield* stack.plan(program(true));
      expect(unchanged.resources.RequirementsGroup?.action).toBe("noop");

      // Drop the requirements: back to the plain launch template, default
      // zone distribution.
      const plain = yield* stack.deploy(program(false));
      expect(plain.instanceRequirements).toBeUndefined();
      expect(plain.launchTemplateId).toEqual(created.launchTemplateId);
      const livePlain = yield* describe(plain.autoScalingGroupName);
      expect(livePlain?.MixedInstancesPolicy).toBeUndefined();
      expect(livePlain?.LaunchTemplate?.LaunchTemplateId).toEqual(created.launchTemplateId);
      expect(
        livePlain?.AvailabilityZoneDistribution?.CapacityDistributionStrategy ??
          "balanced-best-effort",
      ).toEqual("balanced-best-effort");

      // And back to the mixed instances policy.
      const again = yield* stack.deploy(program(true));
      yield* expectMixed(again);

      yield* stack.destroy();
      yield* assertGroupGone(again.autoScalingGroupName);
    }),
  {
    tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ec2", "live"],
    timeout: 300_000,
  },
);
