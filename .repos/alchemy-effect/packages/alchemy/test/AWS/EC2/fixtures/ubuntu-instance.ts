import * as AWS from "@/AWS";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Alchemy-managed EC2 key pair granting SSH access to the Ubuntu instance for
 * debugging bootstrap failures.
 */
export const ubuntuKeyPair = AWS.EC2.KeyPair("Ec2UbuntuKeyPair", {
  keyType: "ed25519",
});

/**
 * Ubuntu 24.04 variant of the hosted-instance e2e fixture (issues #1027 and
 * #1028): Ubuntu AMIs ship without `unzip`, `dnf`, or `yum`, so serving HTTP
 * from the hosted runtime proves the bootstrap's `apt-get` branch installed
 * `unzip`, the AWS CLI install + S3 bundle sync succeeded, and the systemd
 * unit's `bun --no-install` start worked end-to-end.
 */
export default class TestUbuntuInstance extends AWS.EC2.Instance<TestUbuntuInstance>()(
  "Ec2UbuntuE2EInstance",
  Effect.gen(function* () {
    // This composition is re-executed inside the deployed instance's bundle:
    // the AMI lookup is an `Output` resolved at plan/deploy time only, and
    // resource yields resolve to references at runtime, so no runtime guard
    // is needed.
    const network = yield* AWS.EC2.Network("Ec2UbuntuE2ENetwork", {
      cidrBlock: "10.82.0.0/16",
      availabilityZones: 1,
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("Ec2UbuntuE2ESg", {
      vpcId: network.vpcId,
      description: "alchemy ec2 ubuntu instance e2e",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
          description: "app",
        },
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: "0.0.0.0/0",
          description: "ssh",
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

    const key = yield* ubuntuKeyPair;

    return {
      main: import.meta.filename,
      imageId: AWS.EC2.ubuntu2404(),
      instanceType: "t3.small",
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [securityGroup.groupId],
      associatePublicIpAddress: true,
      port: 3000,
      keyName: key.keyName,
    };
  }),
  Effect.gen(function* () {
    const host = yield* ServerHost;
    const ticks = yield* Ref.make(0);

    // Long-running background loop (the `host.run` pattern from #706).
    yield* host.run(
      Ref.update(ticks, (n) => n + 1).pipe(
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.asVoid,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://instance");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/ticks") {
          return yield* HttpServerResponse.json({
            ticks: yield* Ref.get(ticks),
          });
        }
        return HttpServerResponse.text("hello from ubuntu ec2 instance");
      }),
    };
  }),
) {}
