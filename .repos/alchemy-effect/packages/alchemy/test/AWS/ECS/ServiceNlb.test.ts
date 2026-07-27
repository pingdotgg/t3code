import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

class RouteMismatch extends Data.TaggedError("RouteMismatch")<{
  readonly status: number;
  readonly body: string;
}> {}

// NLB + capacity: a `"80/tcp"` listen rule derives a Network Load Balancer
// (type, TCP listener, TCP target group), proven by a live HTTP-over-TCP
// round-trip through the NLB's DNS; a second service on the same cluster
// runs `capacity: "spot"` (describe-level — the strategy is visible on
// `describeServices`, no need to place a task).
//
// Requires a local Docker daemon (the `image:` sources mirror into ECR).
// NLB provisioning + target registration is slower than ALB (~3-4 min).
test.provider.skipIf(!!process.env.FAST)(
  "tcp rules compose an NLB (live round-trip); capacity 'spot' maps to FARGATE_SPOT",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;
      const client = yield* HttpClient.HttpClient;

      // Only the per-AZ default subnets: concurrent suites create extra
      // subnets, and a load balancer rejects two subnets in one AZ.
      const azSubnets = yield* ec2
        .describeSubnets({
          Filters: [
            { Name: "vpc-id", Values: [net.vpcId] },
            { Name: "default-for-az", Values: ["true"] },
          ],
        })
        .pipe(
          Effect.map((r) =>
            (r.Subnets ?? []).flatMap((s) => (s.SubnetId ? [s.SubnetId] : [])),
          ),
        );

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("NlbCluster", {
            clusterName: "alchemy-test-ecs-nlb",
            capacityProviders: ["FARGATE", "FARGATE_SPOT"],
          });
          const base = {
            cluster,
            vpcId: net.vpcId as string,
            subnets: azSubnets,
            // Default-VPC public subnets: tasks need a public IP to pull
            // the mirrored image from ECR without a NAT.
            assignPublicIp: true,
          };
          const echo = yield* Service("NlbEcho", {
            ...base,
            image: "hashicorp/http-echo",
            command: ["-text=nlb-echo"],
            port: 5678,
            desiredCount: 1,
            loadBalancer: { rules: [{ listen: "80/tcp" }] },
          });
          const spot = yield* Service("SpotWorker", {
            ...base,
            image: "busybox:stable",
            command: ["sh", "-c", "while true; do sleep 30; done"],
            desiredCount: 0,
            capacity: "spot",
          });
          return {
            url: echo.url.as<string>(),
            loadBalancerArn: echo.loadBalancerArn.as<string>(),
            targetGroupArn: echo.targetGroupArn.as<string>(),
            listenerArn: echo.listenerArn.as<string>(),
            clusterArn: echo.clusterArn.as<string>(),
            spotServiceName: spot.serviceName.as<string>(),
          };
        }),
      );

      // ── the composed LB is a Network Load Balancer ────────────────────
      const loadBalancers = yield* elbv2.describeLoadBalancers({
        LoadBalancerArns: [deployed.loadBalancerArn],
      });
      const nlb = loadBalancers.LoadBalancers?.[0];
      expect(nlb?.Type).toBe("network");
      // Non-HTTP protocols always carry the port (there is no well-known
      // default for tcp://).
      expect(deployed.url).toBe(`tcp://${nlb?.DNSName}:80`);

      // TCP listener on 80, TCP target group on the container port.
      const listeners = yield* elbv2.describeListeners({
        LoadBalancerArn: deployed.loadBalancerArn,
      });
      const listener = (listeners.Listeners ?? []).find((l) => l.Port === 80);
      expect(listener?.Protocol).toBe("TCP");
      const targetGroups = yield* elbv2.describeTargetGroups({
        TargetGroupArns: [deployed.targetGroupArn],
      });
      expect(targetGroups.TargetGroups?.[0]?.Protocol).toBe("TCP");
      expect(targetGroups.TargetGroups?.[0]?.Port).toBe(5678);

      // ── live round-trip: HTTP over the NLB's TCP listener ─────────────
      yield* client.get(`http://${nlb!.DNSName}/`).pipe(
        Effect.flatMap((res) =>
          Effect.flatMap(res.text, (body) =>
            res.status === 200 && body.includes("nlb-echo")
              ? Effect.void
              : Effect.fail(new RouteMismatch({ status: res.status, body })),
          ),
        ),
        // NLB provisioning + target registration: ~3-4 min worst case.
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      );

      // ── capacity: "spot" arrives as a FARGATE_SPOT strategy ───────────
      const services = yield* ecs.describeServices({
        cluster: deployed.clusterArn,
        services: [deployed.spotServiceName],
      });
      const spotService = services.services?.[0];
      expect(spotService?.capacityProviderStrategy).toEqual([
        { capacityProvider: "FARGATE_SPOT", weight: 1, base: 0 },
      ]);
      expect(spotService?.launchType).toBeUndefined();

      // ── destroy + zero-orphan proofs ──────────────────────────────────
      yield* stack.destroy();

      const nlbGone = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancerArn],
        })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(nlbGone).toBe(true);

      const targetGroupGone = yield* elbv2
        .describeTargetGroups({
          TargetGroupArns: [deployed.targetGroupArn],
        })
        .pipe(
          Effect.map((r) => (r.TargetGroups ?? []).length === 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(targetGroupGone).toBe(true);
    }),
  { timeout: 900_000 },
);
