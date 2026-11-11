import * as AWS from "@alchemy.run/aws";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/**
 * In-stack networking for a real MWAA environment. CreateEnvironment rejects
 * public subnets (`ValidationException: The subnets must be private.`) and the
 * environment needs outbound egress, so this builds a VPC with two private
 * subnets in distinct AZs (plus their public counterparts), an Internet
 * Gateway, and ONE shared NAT gateway, and a security group with the
 * self-referencing all-traffic ingress rule MWAA components need to reach each
 * other.
 *
 * The returned IDs carry dependencies on the NAT route / route-table
 * associations and on the self-referencing rule, so the environment is only
 * created once egress is wired — and is torn down before any of them.
 */
export const MwaaNetwork = (id: string, cidrBlock: string) =>
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network(id, {
      cidrBlock,
      availabilityZones: 2,
      nat: "single",
    });

    const egressRoute = network.privateRoutes[0];
    const subnetIds = network.privateSubnets.map((subnet, index) =>
      Output.all(
        subnet.subnetId,
        network.privateRouteAssociations[index].associationId,
        egressRoute.routeTableId,
      ).pipe(Output.map(([subnetId]) => subnetId)),
    );

    const securityGroup = yield* AWS.EC2.SecurityGroup(`${id}SecurityGroup`, {
      vpcId: network.vpcId,
      description: "MWAA environment",
    });
    const selfIngress = yield* AWS.EC2.SecurityGroupRule(`${id}SelfIngress`, {
      group: securityGroup,
      type: "ingress",
      ipProtocol: "-1",
      referencedGroupId: securityGroup.groupId,
      description: "MWAA components talk to each other",
    });

    return { subnetIds, securityGroupIds: [selfIngress.groupId] };
  });
