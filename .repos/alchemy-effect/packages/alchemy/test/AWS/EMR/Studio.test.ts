import * as AWS from "@/AWS";
import { Studio } from "@/AWS/EMR/Studio.ts";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as emr from "@distilled.cloud/aws/emr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled emr error union carries the
// StudioNotFound tag this provider's read/delete paths depend on (EMR
// overloads InvalidRequestException with "Studio does not exist.").
test.provider(
  "describeStudio on a nonexistent id fails with StudioNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        emr.describeStudio({ StudioId: "es-AAAAAAAAAAAAAAAAAAAAAAAAA" }),
      );
      expect(error._tag).toBe("StudioNotFound");
    }),
);

// Resolve a subnet of the account's default VPC.
const resolveSubnets = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .flatMap((s) => (s.SubnetId ? [s.SubnetId] : []))
    .slice(0, 2);
  return { vpcId: vpc.vpcId, subnetIds };
});

test.provider(
  "lifecycle: create IAM studio, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpcId, subnetIds } = yield* resolveSubnets;
      expect(subnetIds.length).toBeGreaterThan(0);

      const deploy = (description: string, s3Suffix: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* AWS.S3.Bucket("StudioBackup", {
              forceDestroy: true,
            });
            const role = yield* AWS.IAM.Role("StudioServiceRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: ["elasticmapreduce.amazonaws.com"] },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              inlinePolicies: {
                "studio-service": {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      // CreateStudio validates the service role can access
                      // the default S3 location (incl. GetEncryptionConfiguration).
                      Effect: "Allow",
                      Action: ["s3:*"],
                      Resource: [
                        bucket.bucketArn,
                        Output.interpolate`${bucket.bucketArn}/*`,
                      ],
                    },
                    {
                      Effect: "Allow",
                      Action: [
                        "ec2:CreateNetworkInterface",
                        "ec2:CreateNetworkInterfacePermission",
                        "ec2:DeleteNetworkInterface",
                        "ec2:DeleteNetworkInterfacePermission",
                        "ec2:DescribeNetworkInterfaces",
                        "ec2:ModifyNetworkInterfaceAttribute",
                        "ec2:DescribeSecurityGroups",
                        "ec2:DescribeSubnets",
                        "ec2:DescribeVpcs",
                        "ec2:DescribeTags",
                        "ec2:CreateTags",
                      ],
                      Resource: ["*"],
                    },
                  ],
                },
              },
            });
            const workspaceSg = yield* AWS.EC2.SecurityGroup("WorkspaceSg", {
              vpcId: vpcId,
              description: "EMR Studio workspace",
            });
            const engineSg = yield* AWS.EC2.SecurityGroup("EngineSg", {
              vpcId: vpcId,
              description: "EMR Studio engine",
            });
            // Engine must accept TCP 18888 from the workspace security group.
            yield* AWS.EC2.SecurityGroupRule("EngineIngress", {
              groupId: engineSg.groupId,
              type: "ingress",
              ipProtocol: "tcp",
              fromPort: 18888,
              toPort: 18888,
              referencedGroupId: workspaceSg.groupId,
            });
            const studio = yield* Studio("Studio", {
              authMode: "IAM",
              vpcId: vpcId,
              subnetIds,
              serviceRole: role.roleArn,
              workspaceSecurityGroupId: workspaceSg.groupId,
              engineSecurityGroupId: engineSg.groupId,
              defaultS3Location: Output.interpolate`s3://${bucket.bucketName}/${s3Suffix}/`,
              description,
              tags: { fixture: "emr-studio" },
            });
            return { studio };
          }),
        );

      // Create.
      const { studio } = yield* deploy("alchemy test studio", "studio");
      expect(studio.studioId).toMatch(/^es-/);
      expect(studio.studioArn).toContain(":studio/");
      expect(studio.url).toBeDefined();

      // Out-of-band verification via distilled.
      const created = yield* emr.describeStudio({
        StudioId: studio.studioId,
      });
      expect(created.Studio?.AuthMode).toBe("IAM");
      expect(created.Studio?.Description).toBe("alchemy test studio");
      expect(created.Studio?.DefaultS3Location).toContain("/studio/");
      const createdTags = Object.fromEntries(
        (created.Studio?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(createdTags.fixture).toBe("emr-studio");

      // Update — description and default S3 location sync in place (same
      // StudioId, no replacement).
      const { studio: updated } = yield* deploy(
        "alchemy test studio v2",
        "studio-v2",
      );
      expect(updated.studioId).toBe(studio.studioId);
      const afterUpdate = yield* emr.describeStudio({
        StudioId: studio.studioId,
      });
      expect(afterUpdate.Studio?.Description).toBe("alchemy test studio v2");
      expect(afterUpdate.Studio?.DefaultS3Location).toContain("/studio-v2/");

      // Destroy — verify gone out of band.
      yield* stack.destroy();
      const afterDestroy = yield* Effect.flip(
        emr.describeStudio({ StudioId: studio.studioId }),
      );
      expect(afterDestroy._tag).toBe("StudioNotFound");
    }),
  { timeout: 300_000 },
);
