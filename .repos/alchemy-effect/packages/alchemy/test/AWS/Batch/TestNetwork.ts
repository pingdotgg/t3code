import {
  InternetGateway,
  Route,
  RouteTable,
  RouteTableAssociation,
  SecurityGroup,
  Subnet,
  Vpc,
} from "@/AWS/EC2";
import * as Effect from "effect/Effect";

/**
 * A stack-owned public network for Batch tests.
 *
 * Tests must not call CreateDefaultVpc: AWS generates an untaggable collection
 * of default subnets, routes, ACLs, security-group rules, DHCP options, and an
 * internet gateway that no test stack owns. This graph is deterministic and
 * lets the engine delete every component bottom-up during stack.destroy().
 */
export const BatchTestNetwork = Effect.gen(function* () {
  const vpc = yield* Vpc("BatchTestVpc", {
    cidrBlock: "10.73.0.0/16",
  });
  const internetGateway = yield* InternetGateway("BatchTestInternetGateway", {
    vpcId: vpc.vpcId,
  });
  const subnet = yield* Subnet("BatchTestSubnet", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.73.1.0/24",
    mapPublicIpOnLaunch: true,
    // Batch creates service-managed ENIs in this subnet. Those ENIs also
    // prevent the VPC's internet gateway from detaching, but that relationship
    // is implicit in AWS and therefore absent from the engine's prop graph.
    // This harmless tag records the real dependency explicitly so destroy
    // waits for ComputeEnvironment -> Subnet before attempting IGW teardown.
    tags: {
      "alchemy:test:internet-gateway": internetGateway.internetGatewayId,
    },
  });
  const securityGroup = yield* SecurityGroup("BatchTestSecurityGroup", {
    vpcId: vpc.vpcId,
  });
  const routeTable = yield* RouteTable("BatchTestRouteTable", {
    vpcId: vpc.vpcId,
  });
  yield* Route("BatchTestInternetRoute", {
    routeTableId: routeTable.routeTableId,
    destinationCidrBlock: "0.0.0.0/0",
    gatewayId: internetGateway.internetGatewayId,
  });
  yield* RouteTableAssociation("BatchTestSubnetRoute", {
    routeTableId: routeTable.routeTableId,
    subnetId: subnet.subnetId,
  });

  return {
    vpcId: vpc.vpcId,
    subnetIds: [subnet.subnetId],
    securityGroupIds: [securityGroup.groupId],
  };
});
