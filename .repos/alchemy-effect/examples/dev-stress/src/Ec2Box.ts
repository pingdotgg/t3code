import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EC2_MARKER } from "./ec2/marker.ts";
import { PORTS } from "./ports.ts";

/**
 * A hosted **EC2 instance**: the fourth floci compute unit in the stack
 * (after Lambda, the MicroVM, and ECS). Under `alchemy dev` the instance
 * runs as a real docker container in the emulator — its userData boots the
 * bundled program below — and floci publishes the security-group app port
 * behind a host-routing mux, so the box answers at
 * `http://<instanceId>.localhost.floci.io:<port>` on the developer's
 * machine.
 *
 * Unlike the Workers/Lambda (sidecar hot swap) and ECS (image rebuild +
 * container roll), the hosted instance reloads through the ENGINE: a
 * content edit re-plans, the provider re-uploads the bundle in place and
 * reboots the instance — same instance id, same address, new code.
 */
export default class Ec2Box extends AWS.EC2.Instance<Ec2Box>()(
  "StressEc2Box",
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("StressEc2Network", {
      cidrBlock: "10.84.0.0/16",
      availabilityZones: 1,
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("StressEc2Sg", {
      vpcId: network.vpcId,
      description: "dev-stress ec2 box",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: PORTS.ec2,
          toPort: PORTS.ec2,
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
      main: import.meta.filename,
      imageId: AWS.EC2.amazonLinux2023(),
      instanceType: "t3.micro",
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [securityGroup.groupId],
      associatePublicIpAddress: true,
      port: PORTS.ec2,
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://ec2-box");
        if (url.pathname === "/marker") {
          return yield* HttpServerResponse.json({ marker: EC2_MARKER });
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }),
) {}
