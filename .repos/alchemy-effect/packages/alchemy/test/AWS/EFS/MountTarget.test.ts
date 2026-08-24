import * as AWS from "@/AWS";
import type { VpcId } from "@/AWS/EC2";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as efs from "@distilled.cloud/aws/efs";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EFSMountTarget");

// Mount-target churn is the slow part of EFS (1–3 minutes each way), so the
// suite deploys ONE mount target in a `beforeAll`, drives updates against it
// in tests, and tears it down once in `afterAll`. Multi-AZ coverage is gated
// behind AWS_TEST_EFS_MULTI_AZ=1 because it doubles the churn.

let vpcId: VpcId;
let subnetId: string;
let defaultSecurityGroupId: string;
let extraSecurityGroupId: string;
let fileSystemId: string;
let mountTargetId: string;

// Resolve the default VPC, a default subnet, and the default security group
// once. Runs inside a deploy/test effect (the `beforeAll` hook itself has no
// AWS context).
const resolveNetwork = Effect.gen(function* () {
  if (subnetId !== undefined) return;
  const vpc = yield* getDefaultVpc;
  vpcId = vpc.vpcId;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  subnetId = subnets.Subnets![0]!.SubnetId!;
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  defaultSecurityGroupId = groups.SecurityGroups![0]!.GroupId!;
});

const infra = (securityGroups?: () => string[]) =>
  Effect.gen(function* () {
    yield* resolveNetwork;
    const files = yield* AWS.EFS.FileSystem("MtFiles");
    const extraSg = yield* AWS.EC2.SecurityGroup("MtSg", {
      vpcId,
      description: "alchemy EFS mount target test",
    });
    const target = yield* AWS.EFS.MountTarget("MtTarget", {
      fileSystemId: files.fileSystemId,
      subnetId,
      ...(securityGroups !== undefined
        ? { securityGroups: securityGroups() }
        : {}),
    });
    return { files, target, extraSg };
  });

describe.sequential("EFS MountTarget", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      // initial deploy: no explicit security groups → the VPC default group
      const deployed = yield* sharedStack.deploy(infra());
      fileSystemId = deployed.files.fileSystemId;
      mountTargetId = deployed.target.mountTargetId;
      extraSecurityGroupId = deployed.extraSg.groupId;
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  test.provider(
    "mount target is available in the subnet with the default security group",
    () =>
      Effect.gen(function* () {
        expect(mountTargetId).toMatch(/^fsmt-/);

        const observed = yield* efs
          .describeMountTargets({ MountTargetId: mountTargetId })
          .pipe(Effect.map((r) => r.MountTargets![0]));
        expect(observed.LifeCycleState).toBe("available");
        expect(observed.SubnetId).toBe(subnetId);
        expect(observed.FileSystemId).toBe(fileSystemId);
        expect(observed.IpAddress).toBeTruthy();

        const groups = yield* efs.describeMountTargetSecurityGroups({
          MountTargetId: mountTargetId,
        });
        expect(groups.SecurityGroups).toEqual([defaultSecurityGroupId]);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "security groups are modified in place",
    () =>
      Effect.gen(function* () {
        const updated = yield* sharedStack.deploy(
          infra(() => [defaultSecurityGroupId, extraSecurityGroupId]),
        );
        // same mount target — securityGroups is mutable
        expect(updated.target.mountTargetId).toBe(mountTargetId);

        const observed = yield* efs
          .describeMountTargetSecurityGroups({
            MountTargetId: mountTargetId,
          })
          .pipe(Effect.map((r) => [...r.SecurityGroups].sort()));
        expect(observed).toEqual(
          [defaultSecurityGroupId, extraSecurityGroupId].sort(),
        );
      }),
    { timeout: 120_000 },
  );
});

// Full teardown verification for the shared fixture is implicit: the mount
// target's delete waits until it is observed gone (its ENI must release
// before the security group and file system can delete), so a leaked mount
// target fails the afterAll destroy. Multi-AZ is gated — it adds another
// 1–3 minute create/delete cycle per AZ.
test.provider.skipIf(!process.env.AWS_TEST_EFS_MULTI_AZ)(
  "creates one mount target per availability zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const vpc = yield* getDefaultVpc;
      const subnets = yield* EC2.describeSubnets({
        Filters: [
          { Name: "vpc-id", Values: [vpc.vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      });
      const [subnetA, subnetB] = subnets.Subnets!.map((s) => s.SubnetId!);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("MultiAzFiles");
          const targetA = yield* AWS.EFS.MountTarget("MtA", {
            fileSystemId: files.fileSystemId,
            subnetId: subnetA,
          });
          const targetB = yield* AWS.EFS.MountTarget("MtB", {
            fileSystemId: files.fileSystemId,
            subnetId: subnetB,
          });
          return { files, targetA, targetB };
        }),
      );

      expect(deployed.targetA.availabilityZoneName).not.toBe(
        deployed.targetB.availabilityZoneName,
      );

      const observed = yield* efs.describeMountTargets({
        FileSystemId: deployed.files.fileSystemId,
      });
      expect(observed.MountTargets).toHaveLength(2);

      yield* stack.destroy();
      const gone = yield* efs
        .describeMountTargets({ FileSystemId: deployed.files.fileSystemId })
        .pipe(
          Effect.map((r) => (r.MountTargets ?? []).length === 0),
          Effect.catchTag("FileSystemNotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (g) => g,
            times: 36,
          }),
        );
      expect(gone).toBe(true);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 600_000 },
);
