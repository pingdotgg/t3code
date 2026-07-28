import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers() });

const handlerPath = fileURLToPath(
  new URL("./timeout-handler.ts", import.meta.url),
);

// Repro for https://github.com/xofromthemoon/alchemy-aws-demo — a VPC-attached
// Lambda leaves Hyperplane ENIs in its subnets/security group after
// DeleteFunction. AWS releases them asynchronously (up to ~20 minutes), which
// used to outlive the Subnet/SecurityGroup DependencyViolation retry budgets
// and fail the destroy, forcing users to run destroy multiple times. The
// delete paths now reap detached Lambda ENIs explicitly so a single destroy
// converges. Slow (minutes of AWS-side ENI release), so FAST-gated.
test.provider.skipIf(!!process.env.FAST)(
  "destroy converges in one pass with a VPC-attached function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const network = yield* AWS.EC2.Network("Network", {
          cidrBlock: "10.42.0.0/16",
          availabilityZones: 2,
          nat: "none",
        });

        const sg = yield* AWS.EC2.SecurityGroup("FunctionSecurityGroup", {
          vpcId: network.vpcId,
          description: "VPC lambda destroy repro",
          ingress: [
            {
              ipProtocol: "tcp",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "10.42.0.0/16",
              description: "intra-vpc https",
            },
          ],
        });

        const fn = yield* AWS.Lambda.Function("VpcFn", {
          main: handlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          vpc: {
            subnetIds: network.privateSubnetIds,
            securityGroupIds: [sg.groupId],
          },
        });

        return {
          vpcId: network.vpcId,
          privateSubnetIds: network.privateSubnetIds,
          groupId: sg.groupId,
          functionName: fn.functionName,
        };
      });

      const deployed = yield* stack.deploy(program);

      // The function's Hyperplane ENI(s) materialize in the private subnets
      // shortly after the function goes Active — poll (describe is
      // eventually consistent right after deploy). Note: attached Hyperplane
      // ENIs report InterfaceType "lambda"; once detached they flip to plain
      // "interface" and only the description identifies them.
      const isLambdaEni = (eni: EC2.NetworkInterface): boolean =>
        eni.InterfaceType === "lambda" ||
        (eni.Description?.startsWith("AWS Lambda VPC ENI") ?? false);
      const before = yield* EC2.describeNetworkInterfaces({
        Filters: [{ Name: "vpc-id", Values: [deployed.vpcId] }],
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (page) => (page.NetworkInterfaces ?? []).some(isLambdaEni),
          times: 36,
        }),
      );
      expect((before.NetworkInterfaces ?? []).some(isLambdaEni)).toBe(true);

      // One destroy must fully tear down: function, SG, subnets, VPC.
      yield* stack.destroy();

      const vpcs = yield* EC2.describeVpcs({
        VpcIds: [deployed.vpcId],
      }).pipe(
        Effect.catchTag("InvalidVpcID.NotFound", () =>
          Effect.succeed({ Vpcs: [] }),
        ),
      );
      expect(vpcs.Vpcs ?? []).toHaveLength(0);
    }),
  { timeout: 30 * 60 * 1000 },
);
