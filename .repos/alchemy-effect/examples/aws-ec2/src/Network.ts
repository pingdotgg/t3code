import * as AWS from "alchemy/AWS";
import type { Output } from "alchemy/Output";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ExampleNetwork {
  network: AWS.EC2.Network;
  publicSubnetIds: Output<AWS.EC2.SubnetId>[];
  appSecurityGroupId: Output<AWS.EC2.SecurityGroupId>;
}

export class Network extends Context.Service<Network, ExampleNetwork>()(
  "Network",
) {}

export const NetworkLive = Layer.effect(
  Network,
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 2,
      nat: "single",
    });

    const appSecurityGroup = yield* AWS.EC2.SecurityGroup("AppSecurityGroup", {
      vpcId: network.vpcId,
      description: "Security group for the EC2 application instance",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
        },
      ],
    });

    return {
      network,
      publicSubnetIds: network.publicSubnetIds,
      appSecurityGroupId: appSecurityGroup.groupId,
    };
  }),
);
