import * as AWS from "@/AWS";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup.ts";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { deriveRulePriority, Service } from "@/AWS/ECS/Service.ts";
import { Listener } from "@/AWS/ELBv2/Listener.ts";
import { LoadBalancer } from "@/AWS/ELBv2/LoadBalancer.ts";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// ── auto-priority determinism (pure, no cloud) ──────────────────────────────
//
// Rules that omit `priority` get one derived from the rule's namespaced
// logical id via a stable FNV-1a hash into 1–50000. The exact values are
// pinned so the derivation can never silently change between runs/releases —
// a changed hash would re-prioritize (replace) every auto-prioritized rule.
test(
  "auto-derived rule priorities are deterministic and distinct",
  Effect.sync(() => {
    // Pinned values (computed once; stable forever).
    expect(deriveRulePriority("SharedAlbStack/EchoA/Rule-0")).toBe(21915);
    expect(deriveRulePriority("SharedAlbStack/EchoB/Rule-0")).toBe(6262);
    expect(deriveRulePriority("Api/Rule-0")).toBe(13044);
    expect(deriveRulePriority("Api/Rule-1")).toBe(35425);

    // Same input ⇒ same output; distinct inputs ⇒ distinct outputs.
    const ids = [
      "SharedAlbStack/EchoA/Rule-0",
      "SharedAlbStack/EchoA/Rule-1",
      "SharedAlbStack/EchoB/Rule-0",
      "SharedAlbStack/EchoB/Rule-1",
      "Api/Rule-0",
      "Api/Rule-1",
    ];
    const first = ids.map(deriveRulePriority);
    expect(ids.map(deriveRulePriority)).toEqual(first);
    expect(new Set(first).size).toBe(ids.length);
    for (const priority of first) {
      expect(Number.isInteger(priority)).toBe(true);
      expect(priority).toBeGreaterThanOrEqual(1);
      expect(priority).toBeLessThanOrEqual(50000);
    }
  }),
);

class RouteMismatch extends Data.TaggedError("RouteMismatch")<{
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {}

// ── shared-ALB end-to-end ───────────────────────────────────────────────────
//
// One stack owns an ALB + HTTP listener at stack level; TWO cheap external
// `image:` services share that listener with distinct `path` rules. Each
// service composes only its own TargetGroup + ListenerRule (+ managed SG).
// We assert both paths route through the ALB DNS, then destroy ONE service
// and assert its rule + target group are gone while the other service still
// routes and the ALB/listener are untouched. Finally a full destroy with
// out-of-band zero-orphan proofs.
//
// Requires a local Docker daemon (the `image:` source mirrors into ECR).
// FAST runs skip it: ALB provisioning + Fargate startup + ENI release put it
// well past the fast budget.
test.provider.skipIf(!!process.env.FAST)(
  "two services share one listener; destroying one leaves the other routing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;
      const client = yield* HttpClient.HttpClient;

      // Only the per-AZ default subnets (one per AZ): concurrent suite runs
      // create extra subnets in the default VPC, and an ALB rejects two
      // subnets in the same Availability Zone.
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

      const program = (includeEchoB: boolean) =>
        Effect.gen(function* () {
          const cluster = yield* Cluster("SharedAlbCluster", {
            clusterName: "alchemy-test-ecs-shared-alb",
          });
          // The shared ALB + listener are stack-level resources owned by
          // NEITHER service. Unmatched requests hit the 404 default action.
          const albSg = yield* SecurityGroup("SharedAlbSg", {
            vpcId: net.vpcId,
            description: "shared ALB ingress for alchemy ECS tests",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
              },
            ],
          });
          const alb = yield* LoadBalancer("SharedAlb", {
            type: "application",
            scheme: "internet-facing",
            subnets: azSubnets as `subnet-${string}`[],
            securityGroups: [albSg.groupId],
          });
          const listener = yield* Listener("SharedHttp", {
            loadBalancerArn: alb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "fixedResponse",
                statusCode: "404",
                contentType: "text/plain",
                messageBody: "no rule",
              },
            ],
          });

          const base = {
            cluster,
            image: "hashicorp/http-echo",
            port: 5678,
            desiredCount: 1,
            vpcId: net.vpcId as string,
            subnets: azSubnets,
            // Default-VPC public subnets: tasks need a public IP to pull
            // the mirrored image from ECR without a NAT.
            assignPublicIp: true,
          };
          const echoA = yield* Service("EchoA", {
            ...base,
            command: ["-text=svc-a"],
            loadBalancer: { listener, rules: [{ path: "/a*" }] },
          });
          const echoB = includeEchoB
            ? yield* Service("EchoB", {
                ...base,
                command: ["-text=svc-b"],
                loadBalancer: { listener, rules: [{ path: "/b*" }] },
              })
            : undefined;
          return {
            albArn: alb.loadBalancerArn.as<string>(),
            albDns: alb.dnsName.as<string>(),
            listenerArn: listener.listenerArn.as<string>(),
            aTargetGroupArn: echoA.targetGroupArn.as<string>(),
            aUrl: echoA.url.as<string>(),
            bTargetGroupArn: echoB?.targetGroupArn.as<string>(),
          };
        });

      const fetchRoute = (dns: string, path: string) =>
        client
          .get(`http://${dns}${path}`)
          .pipe(
            Effect.flatMap((res) =>
              Effect.map(res.text, (body) => ({ status: res.status, body })),
            ),
          );
      // Bounded route poll: ALB provisioning (~2 min) + Fargate task start +
      // fast-converge health checks (~20s). Under a saturated full-suite run
      // ALB DNS propagation alone can eat several minutes, so the budget is
      // generous (~7 min) — the happy path exits on the first 200.
      const awaitRoute = (dns: string, path: string, expected: string) =>
        fetchRoute(dns, path).pipe(
          Effect.flatMap(({ status, body }) =>
            status === 200 && body.includes(expected)
              ? Effect.void
              : Effect.fail(new RouteMismatch({ path, status, body })),
          ),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 84 }),
        );

      // ── deploy both services on the shared listener ────────────────────
      const deployed = yield* stack.deploy(program(true));
      expect(deployed.aTargetGroupArn).toBeTruthy();
      expect(deployed.bTargetGroupArn).toBeTruthy();
      expect(deployed.aTargetGroupArn).not.toBe(deployed.bTargetGroupArn);
      // Shared ingress derives the service URL from the shared ALB's DNS.
      expect(deployed.aUrl).toBe(`http://${deployed.albDns}`);

      // Both paths route to their service; unmatched paths hit the
      // listener's own 404 default action.
      yield* awaitRoute(deployed.albDns, "/a", "svc-a");
      yield* awaitRoute(deployed.albDns, "/b", "svc-b");
      const unmatched = yield* fetchRoute(deployed.albDns, "/c");
      expect(unmatched.status).toBe(404);

      // Out-of-band: exactly two non-default rules on the shared listener.
      const rulesBefore = yield* elbv2.describeRules({
        ListenerArn: deployed.listenerArn,
      });
      expect((rulesBefore.Rules ?? []).filter((r) => !r.IsDefault).length).toBe(
        2,
      );

      // ── destroy ONE service (EchoB) ────────────────────────────────────
      yield* stack.deploy(program(false));

      // Its rule + target group are gone...
      const bTargetGroupGone = yield* elbv2
        .describeTargetGroups({
          TargetGroupArns: [deployed.bTargetGroupArn!],
        })
        .pipe(
          Effect.map((r) => (r.TargetGroups ?? []).length === 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(bTargetGroupGone).toBe(true);
      const rulesAfter = yield* elbv2.describeRules({
        ListenerArn: deployed.listenerArn,
      });
      expect((rulesAfter.Rules ?? []).filter((r) => !r.IsDefault).length).toBe(
        1,
      );

      // ...the shared ALB + listener are untouched...
      const albAfter = yield* elbv2.describeLoadBalancers({
        LoadBalancerArns: [deployed.albArn],
      });
      expect((albAfter.LoadBalancers ?? []).length).toBe(1);

      // ...EchoA still routes, and /b now falls through to the 404 default.
      yield* awaitRoute(deployed.albDns, "/a", "svc-a");
      yield* fetchRoute(deployed.albDns, "/b").pipe(
        Effect.flatMap(({ status, body }) =>
          status === 404
            ? Effect.void
            : Effect.fail(new RouteMismatch({ path: "/b", status, body })),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
      );

      // ── full destroy + zero-orphan proofs ──────────────────────────────
      yield* stack.destroy();

      const albGone = yield* elbv2
        .describeLoadBalancers({ LoadBalancerArns: [deployed.albArn] })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(albGone).toBe(true);

      const aTargetGroupGone = yield* elbv2
        .describeTargetGroups({
          TargetGroupArns: [deployed.aTargetGroupArn],
        })
        .pipe(
          Effect.map((r) => (r.TargetGroups ?? []).length === 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(aTargetGroupGone).toBe(true);

      const listenerGone = yield* elbv2
        .describeRules({ ListenerArn: deployed.listenerArn })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ListenerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(listenerGone).toBe(true);
    }),
  { timeout: 900_000 },
);
