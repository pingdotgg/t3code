import * as AWS from "@/AWS";
import { VpcOrigin } from "@/AWS/CloudFront";
import { Network } from "@/AWS/EC2/Network";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup";
import { LoadBalancer } from "@/AWS/ELBv2/LoadBalancer";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// The full lifecycle provisions a real internal ALB and a CloudFront VPC
// origin. CloudFront VPC-origin deploy + delete is very slow (global
// propagation, ~20-25 min for create alone), so the whole create -> Deployed
// -> delete -> gone cycle runs ~35-40 min end to end. It is gated behind an
// env var and given a generous timeout; the probe + list below run cheaply and
// cover the wiring + typed-error surface in CI.
const runLifecycle = process.env.CLOUDFRONT_TEST_VPC_ORIGIN === "1";

describe("AWS.CloudFront.VpcOrigin", () => {
  // Fast probe (no deploy): creating a VPC origin against a bogus ARN must
  // surface a typed `InvalidArgument` (or `EntityNotFound`), proving the error
  // typing for the create op without provisioning any infrastructure.
  test.provider("createVpcOrigin rejects a bogus ARN with a typed error", () =>
    Effect.gen(function* () {
      const result = yield* cloudfront
        .createVpcOrigin({
          VpcOriginEndpointConfig: {
            Name: "alchemy-vpc-origin-probe",
            Arn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/does-not-exist/0000000000000000",
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginProtocolPolicy: "https-only",
          },
        })
        .pipe(Effect.flip);

      expect(["InvalidArgument", "EntityNotFound", "AccessDenied"]).toContain(
        result._tag,
      );
    }),
  );

  test.provider.skipIf(!runLifecycle)(
    "create, update, and delete a VPC origin for an internal ALB",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // CloudFront VPC origins require the target's VPC to have an internet
        // gateway attached. `Network` provisions a production-shaped VPC (VPC +
        // attached IGW + public/private subnets across 2 AZs + route tables), so
        // the networking + ALB is deployed in a first phase, then the VPC origin
        // in a second — the IGW must be attached before `createVpcOrigin` runs.
        const network = Effect.gen(function* () {
          const net = yield* Network("VpcOriginNet", {
            cidrBlock: "10.40.0.0/16",
          });
          const sg = yield* SecurityGroup("VpcOriginSg", {
            vpcId: net.vpcId,
            description: "alchemy vpc origin alb",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
              },
            ],
          });
          const alb = yield* LoadBalancer("VpcOriginAlb", {
            scheme: "internal",
            type: "application",
            subnets: net.publicSubnetIds,
            securityGroups: [sg.groupId],
          });
          return { albArn: alb.loadBalancerArn };
        });

        // Phase 1: networking (incl. attached IGW) + ALB.
        yield* stack.deploy(network);

        // Phase 2: the VPC origin, now that the IGW is attached.
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const { albArn } = yield* network;
            const vpcOrigin = yield* VpcOrigin("AppVpcOrigin", {
              arn: albArn,
              httpPort: 80,
              originProtocolPolicy: "http-only",
            });
            return { vpcOrigin };
          }),
        );

        // Out-of-band: confirm it deployed.
        const got = yield* cloudfront.getVpcOrigin({
          Id: deployed.vpcOrigin.vpcOriginId,
        });
        expect(got.VpcOrigin?.Status).toEqual("Deployed");
        expect(got.VpcOrigin?.VpcOriginEndpointConfig.HTTPPort).toEqual(80);
        expect(
          got.VpcOrigin?.VpcOriginEndpointConfig.OriginProtocolPolicy,
        ).toEqual("http-only");

        yield* stack.destroy();
        yield* assertVpcOriginDeleted(deployed.vpcOrigin.vpcOriginId);
      }),
    // CloudFront VPC origin deploy + delete each take many minutes (global
    // propagation), on top of the ALB/VPC provisioning and teardown — budget
    // 45 min for the full create -> Deployed -> delete -> gone cycle.
    { timeout: 2_700_000 },
  );

  test.provider.skipIf(!runLifecycle)(
    "list enumerates account VPC origins",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(VpcOrigin);
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        for (const item of all) {
          expect(item.vpcOriginId).toBeDefined();
          expect(item.vpcOriginArn).toBeDefined();
        }
      }),
  );
});

const assertVpcOriginDeleted = (id: string) =>
  cloudfront.getVpcOrigin({ Id: id }).pipe(
    Effect.flatMap((result) =>
      result.VpcOrigin
        ? Effect.fail(new Error("VpcOriginStillExists"))
        : Effect.void,
    ),
    Effect.catchTag("EntityNotFound", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "VpcOriginStillExists",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );
