import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { LoadBalancer } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Reuse the account/region default VPC and carve stack-owned subnets (subnets
// don't count against the VPC limit). An ALB needs subnets in at least two AZs.
test.provider(
  "list enumerates the deployed load balancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const azs =
        azResult.AvailabilityZones?.filter(
          (az) => az.State === "available",
        ).flatMap((az) => (az.ZoneName ? [az.ZoneName] : [])) ?? [];
      const [az1, az2] = azs;
      expect(az1).toBeTruthy();
      expect(az2).toBeTruthy();

      const defaultVpc = yield* getDefaultVpc;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet1 = yield* Subnet("ListLbSubnet1", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(222),
            availabilityZone: az1,
          });

          const subnet2 = yield* Subnet("ListLbSubnet2", {
            vpcId: defaultVpc.vpcId,
            cidrBlock: defaultVpc.subnetCidrBlock(223),
            availabilityZone: az2,
          });

          const loadBalancer = yield* LoadBalancer("ListLb", {
            subnets: [subnet1.subnetId, subnet2.subnetId],
            scheme: "internal",
            type: "application",
          });

          return { loadBalancer };
        }),
      );

      const provider = yield* Provider.findProvider(LoadBalancer);
      const all = yield* provider.list();

      expect(
        all.some(
          (x) => x.loadBalancerArn === deployed.loadBalancer.loadBalancerArn,
        ),
      ).toBe(true);

      yield* stack.destroy();

      // Out-of-band: the load balancer is gone after destroy.
      const after = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancer.loadBalancerArn],
        })
        .pipe(
          Effect.map((r) => r.LoadBalancers?.length ?? 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(0),
          ),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
