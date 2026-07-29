import * as AWS from "@/AWS";
import { SecurityGroup, Subnet, Vpc } from "@/AWS/EC2";
import { Role } from "@/AWS/IAM";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Lambda MicroVM network connectors are a preview feature. Creation provisions
// ENIs in the VPC and can take several minutes to reach ACTIVE (we've observed
// the full lifecycle blowing a 25-minute budget and leaking its VPC — which
// then starves the account's 5-VPC quota and fails unrelated EC2 suites), and
// the API requires an account that is onboarded to the preview. Gate the live
// lifecycle behind LAMBDA_TEST_NETWORK_CONNECTOR=1 so an entitled account runs
// it unchanged.
test.provider.skipIf(!process.env.LAMBDA_TEST_NETWORK_CONNECTOR)(
  "create, update, list, delete network connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const az = azResult.AvailabilityZones?.find(
        (z) => z.State === "available",
      )?.ZoneName!;

      const infra = (networkProtocol: lambdacore.NetworkProtocol) =>
        Effect.gen(function* () {
          // The DualStack update step requires the subnet to carry an IPv6
          // CIDR, so provision the VPC with an Amazon-provided /56 and carve
          // the subnet the first /64 out of it.
          const vpc = yield* Vpc("ConnectorVpc", {
            cidrBlock: "10.0.0.0/16",
            amazonProvidedIpv6CidrBlock: true,
          });
          const subnet = yield* Subnet("ConnectorSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
            availabilityZone: az,
            ipv6CidrBlock: vpc.ipv6CidrBlockAssociationSet.pipe(
              Output.map((set) => set![0]!.ipv6CidrBlock.replace("/56", "/64")),
            ),
          });
          const sg = yield* SecurityGroup("ConnectorSg", {
            vpcId: vpc.vpcId,
            description: "MicroVM egress",
          });
          const role = yield* Role("ConnectorOperator", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            // The connector service assumes this role to manage ENIs in the VPC.
            inlinePolicies: {
              "eni-management": {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "ec2:CreateNetworkInterface",
                      "ec2:DescribeNetworkInterfaces",
                      "ec2:DeleteNetworkInterface",
                      "ec2:DescribeSubnets",
                      "ec2:DescribeSecurityGroups",
                      "ec2:DescribeVpcs",
                      "ec2:AssignPrivateIpAddresses",
                      "ec2:UnassignPrivateIpAddresses",
                      "ec2:CreateTags",
                    ],
                    Resource: "*",
                  },
                ],
              },
            },
          });
          const connector = yield* AWS.Lambda.NetworkConnector("Connector", {
            subnetIds: [subnet.subnetId],
            securityGroupIds: [sg.groupId],
            networkProtocol,
            operatorRole: role.roleArn,
          });
          return { connector };
        });

      // --- create ---
      const created = yield* stack.deploy(infra("IPv4"));
      expect(created.connector.state).toBe("ACTIVE");
      expect(created.connector.networkConnectorArn).toContain(
        "network-connector",
      );

      const fetched = yield* lambdacore.getNetworkConnector({
        Identifier: created.connector.networkConnectorId,
      });
      expect(fetched.State).toBe("ACTIVE");

      // --- update (network protocol) ---
      const updated = yield* stack.deploy(infra("DualStack"));
      expect(updated.connector.networkConnectorArn).toBe(
        created.connector.networkConnectorArn,
      );
      expect(updated.connector.networkProtocol).toBe("DualStack");

      // --- list ---
      const provider = yield* Provider.findProvider(
        AWS.Lambda.NetworkConnector,
      );
      const all = yield* provider.list();
      expect(
        all.some(
          (c) => c.networkConnectorId === created.connector.networkConnectorId,
        ),
      ).toBe(true);

      // --- delete ---
      yield* stack.destroy();
      const afterDestroy = yield* lambdacore
        .getNetworkConnector({
          Identifier: created.connector.networkConnectorId,
        })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterDestroy).toBeUndefined();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 1_500_000 },
);
