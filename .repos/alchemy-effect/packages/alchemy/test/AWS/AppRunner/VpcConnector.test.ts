import * as AWS from "@/AWS";
import { VpcConnector } from "@/AWS/AppRunner";
import { SecurityGroup, Subnet, Vpc } from "@/AWS/EC2";
import * as Test from "@/Test/Alchemy";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertSecurityGroupGone,
  assertSubnetGone,
  assertVpcGone,
} from "../EC2/Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

// VPC connector creation is fast (deletion marks it INACTIVE immediately;
// ENI teardown happens asynchronously server-side), so the lifecycle runs
// ungated on a deterministic, stack-owned network.
test.provider(
  "create and destroy a VPC connector on a stack-owned VPC",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { connector, securityGroup, subnet, vpc } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ConnectorVpc", {
            cidrBlock: "10.84.0.0/16",
          });
          const subnet = yield* Subnet("ConnectorSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.84.1.0/24",
          });
          const securityGroup = yield* SecurityGroup("ConnectorSecurityGroup", {
            vpcId: vpc.vpcId,
          });
          const connector = yield* VpcConnector("Connector", {
            subnets: [subnet.subnetId],
            securityGroups: [securityGroup.groupId],
          });
          return { connector, securityGroup, subnet, vpc };
        }),
      );
      expect(connector.vpcConnectorName.length).toBeGreaterThanOrEqual(4);
      expect(connector.vpcConnectorArn).toContain(":vpcconnector/");
      // App Runner returns lowercase statuses despite documenting uppercase.
      expect(connector.status.toUpperCase()).toBe("ACTIVE");
      expect(connector.vpcConnectorRevision).toBeGreaterThanOrEqual(1);

      // Out-of-band verification via distilled.
      const described = yield* apprunner.describeVpcConnector({
        VpcConnectorArn: connector.vpcConnectorArn,
      });
      expect(described.VpcConnector.VpcConnectorName).toBe(
        connector.vpcConnectorName,
      );
      expect(described.VpcConnector.Status?.toUpperCase()).toBe("ACTIVE");
      expect(described.VpcConnector.Subnets).toEqual([subnet.subnetId]);
      expect(described.VpcConnector.SecurityGroups).toEqual([
        securityGroup.groupId,
      ]);

      // Destroy and verify deletion out-of-band: deleted connectors read
      // INACTIVE (or disappear entirely).
      yield* stack.destroy();
      const after = yield* apprunner
        .describeVpcConnector({
          VpcConnectorArn: connector.vpcConnectorArn,
        })
        .pipe(
          Effect.map((r) =>
            (r.VpcConnector.Status ?? "INACTIVE").toUpperCase(),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("GONE" as const),
          ),
        );
      expect(["INACTIVE", "GONE"]).toContain(after);

      // The connector must release its managed ENIs before the dependency
      // graph is considered destroyed, leaving no App Runner test network
      // resources for nuke to discover.
      yield* assertSubnetGone(subnet.subnetId);
      yield* assertSecurityGroupGone(securityGroup.groupId);
      yield* assertVpcGone(vpc.vpcId);
    }),
  { timeout: 180_000 },
);
