import * as AWS from "@/AWS";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Alchemy-managed EC2 key pair granting SSH access to the instance. Exported so
 * the test can resolve it in the same deploy and read its (redacted) private
 * key — yielding the same logical id returns the same resource.
 */
export const keyPair = AWS.EC2.KeyPair("Ec2E2EKeyPair", {
  keyType: "ed25519",
});

/**
 * End-to-end fixture for a hosted `AWS.EC2.Instance`: a long-running server.
 *
 * The props Effect provisions the networking (a public-subnet VPC) and the
 * instance's security group, then launches the instance into it. The program
 * Effect registers a `ServerHost.run` background loop (the #706 pattern) and
 * returns a `{ fetch }` handler that the instance's Bun HTTP server serves on
 * `port`. `/ticks` reports the loop counter so the test can prove the
 * background loop runs inside the deployed instance.
 */
export default class TestInstance extends AWS.EC2.Instance<TestInstance>()(
  "Ec2E2EInstance",
  Effect.gen(function* () {
    // Props (image AMI lookup, networking) are only needed at plan/deploy
    // time. Inside the deployed instance the resource already exists and only
    // `exports.program` is used, so short-circuit before the infra-resolving
    // calls — `__ALCHEMY_RUNTIME__` is folded to `true` in the bundle, so this
    // branch (and the AWS SDK it pulls in) is dead-code-eliminated from the
    // image.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      // Only the required props need a value here; the infra-derived ones
      // (subnetId / securityGroupIds / …) are unused at runtime and are left
      // unset so the stub still satisfies `InstanceProps`.
      return {
        main: import.meta.filename,
        imageId: "",
        instanceType: "t3.small",
        port: 3000,
      };
    }

    const imageId = yield* AWS.EC2.amazonLinux2023();
    if (!imageId) {
      return yield* Effect.die(
        new Error("could not resolve an Amazon Linux 2023 AMI"),
      );
    }
    const network = yield* AWS.EC2.Network("Ec2E2ENetwork", {
      cidrBlock: "10.81.0.0/16",
      availabilityZones: 1,
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("Ec2E2ESg", {
      vpcId: network.vpcId,
      description: "alchemy ec2 instance e2e",
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

    // An Alchemy-managed EC2 key pair grants SSH access to the instance.
    const key = yield* keyPair;

    return {
      main: import.meta.filename,
      imageId,
      instanceType: "t3.small",
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [securityGroup.groupId],
      associatePublicIpAddress: true,
      port: 3000,
      keyName: key.keyName,
      // SSM access so the instance is manageable via Session Manager.
      roleManagedPolicyArns: [
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      ],
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
        return HttpServerResponse.text("hello from ec2 instance");
      }),
    };
  }),
) {}
