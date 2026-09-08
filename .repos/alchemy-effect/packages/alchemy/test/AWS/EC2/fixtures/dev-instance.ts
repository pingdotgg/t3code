import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Marker served by the hosted program, proving over HTTP that the deployed
 * instance runs THIS build of the bundle.
 */
export const MARKER = "ec2-dev-marker-v1";

/**
 * Hosted EC2 instance fixture for the local (floci) dev test: a
 * public-subnet network, a security group opening the app port, and a
 * hosted `{ fetch }` program served by the instance's Bun HTTP server on
 * `:3000`. Under `alchemy dev` the instance runs as a docker container in
 * the emulator; the security-group ingress makes floci publish the app
 * port behind its host-routing mux, so
 * `http://<instanceId>.localhost.floci.io:3000` reaches the program from
 * the host.
 */
export default class DevInstance extends AWS.EC2.Instance<DevInstance>()(
  "Ec2DevInstance",
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("Ec2DevNetwork", {
      cidrBlock: "10.83.0.0/16",
      availabilityZones: 1,
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("Ec2DevSg", {
      vpcId: network.vpcId,
      description: "alchemy ec2 dev-mode e2e",
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
      main: import.meta.filename,
      imageId: AWS.EC2.amazonLinux2023(),
      instanceType: "t3.micro",
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
        if (url.pathname === "/marker") {
          return HttpServerResponse.text(MARKER);
        }
        return HttpServerResponse.text("hello from ec2 dev instance");
      }),
    };
  }),
) {}
