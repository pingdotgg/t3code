import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../../IsolatedProject.ts";

/**
 * The isolated consumer project this instance's program is bundled from
 * (see `test/IsolatedProject.ts`): `main` lives outside the repository, so
 * the bundle `cwd` resolves none of alchemy's dependencies and the bun
 * bootstrap's own imports must be anchored by the bundler.
 */
export const project = isolatedProject("ec2-instance", import.meta.filename);

/**
 * Minimal hosted `AWS.EC2.Instance` program served from an isolated project.
 * The props Effect provisions a one-AZ public network and a security group
 * opening the app port; `/health` answering 200 from the instance's public
 * IP proves the generated bootstrap booted under the systemd unit — with its
 * imports left external bun dies at module load and nothing ever listens.
 */
export default class IsolatedProjectInstance extends AWS.EC2.Instance<IsolatedProjectInstance>()(
  "Ec2IsolatedProjectInstance",
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("Ec2IsolatedProjectNetwork", {
      cidrBlock: "10.83.0.0/16",
      availabilityZones: 1,
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("Ec2IsolatedProjectSg", {
      vpcId: network.vpcId,
      description: "alchemy ec2 isolated-project e2e",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
          description: "app",
        },
      ],
      egress: [
        {
          ipProtocol: "-1",
          cidrIpv4: "0.0.0.0/0",
          description: "all outbound",
        },
      ],
    });
    return {
      main: project.main,
      imageId: AWS.EC2.amazonLinux2023(),
      instanceType: "t3.small",
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [securityGroup.groupId],
      associatePublicIpAddress: true,
      port: 3000,
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://instance");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("hello from isolated project");
      }),
    };
  }),
) {}
