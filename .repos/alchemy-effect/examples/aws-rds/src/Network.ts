import * as AWS from "alchemy/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ExampleNetwork {
  vpc: AWS.EC2.Network;
  functionSecurityGroup: AWS.EC2.SecurityGroup;
  databaseSecurityGroup: AWS.EC2.SecurityGroup;
  privateSecurityGroups: AWS.EC2.SecurityGroup[];
}

export class Network extends Context.Service<Network, ExampleNetwork>()(
  "Network",
) {}

export const NetworkLive = Layer.effect(
  Network,
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.0.0.0/16",
      availabilityZones: 2,
      nat: "single",
    });

    const functionSecurityGroup = yield* AWS.EC2.SecurityGroup(
      "FunctionSecurityGroup",
      {
        vpcId: network.vpcId,
        description: "Security group for the RDS example Lambda function",
      },
    );

    const databaseSecurityGroup = yield* AWS.EC2.SecurityGroup(
      "DatabaseSecurityGroup",
      {
        vpcId: network.vpcId,
        description: "Security group for the RDS example Aurora cluster",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 5432,
            toPort: 5432,
            referencedGroupId: functionSecurityGroup.groupId,
            description: "Allow Lambda to reach Aurora PostgreSQL",
          },
        ],
      },
    );

    return {
      vpc: network,
      functionSecurityGroup,
      databaseSecurityGroup,
      privateSecurityGroups: [functionSecurityGroup],
    } satisfies ExampleNetwork;
  }),
);
