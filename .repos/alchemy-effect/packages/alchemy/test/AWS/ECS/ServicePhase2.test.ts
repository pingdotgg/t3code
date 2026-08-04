import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Test from "@/Test/Alchemy";
import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

class RouteMismatch extends Data.TaggedError("RouteMismatch")<{
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {}

// The container compares its secret-sourced env vars against the KNOWN seed
// values and serves PRESENCE booleans (never the values) plus a /health
// route via busybox httpd.
//
// NOTE: an Effect-native fixture (`main:` + `{ fetch }`) would be the
// preferred shape here, but the Platform class form with Effect-valued
// props (needed to reference the cluster/parameter/secret) currently OOMs
// during construction — a pre-existing Platform.ts bug independent of the
// props under test. The external `image:` form covers the same Phase-2
// surface: `secrets`, `loadBalancer.health`, `scaling`, and
// `logging.retention` are all provider/composition-level features.
const SERVE_SCRIPT = [
  "mkdir -p /www",
  `if [ "$PHASE2_PARAM" = "phase2-parameter-value" ] && [ "$PHASE2_SECRET" = "phase2-secret-value" ]; then echo '{"param":true,"secret":true}' > /www/secrets; else echo '{"param":false,"secret":false}' > /www/secrets; fi`,
  "echo ok > /www/health",
  "exec httpd -f -p 3000 -h /www",
].join(" && ");

// Phase-2 kitchen sink: one service exercising `secrets` (SSM parameter +
// Secrets Manager secret injected via valueFrom), `loadBalancer.health`
// (per-TG override to /health), `scaling` (CPU + ALB request-count target
// tracking; asserted by describing the scalable target + policies, NOT by
// waiting for a scale event), and `logging.retention` — with a live HTTP
// round-trip over the owned ALB proving the container runs, the health
// override passes, and the secrets arrived (presence only).
//
// Requires a local Docker daemon (the `image:` source mirrors into ECR).
test.provider.skipIf(!!process.env.FAST)(
  "phase2 service wires secrets, health overrides, scaling, and log retention",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getDefaultVpcNetwork;
      const client = yield* HttpClient.HttpClient;

      // Only the per-AZ default subnets: concurrent suites create extra
      // subnets, and an ALB rejects two subnets in one AZ.
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
          const cluster = yield* Cluster("Phase2Cluster", {
            clusterName: "alchemy-test-ecs-phase2",
          });
          const parameter = yield* AWS.SSM.Parameter("Phase2Param", {
            value: "phase2-parameter-value",
          });
          const secret = yield* AWS.SecretsManager.Secret("Phase2Secret", {
            secretString: Redacted.make("phase2-secret-value"),
          });
          const service = yield* Service("Phase2Api", {
            cluster,
            image: "busybox:stable",
            command: ["sh", "-c", SERVE_SCRIPT],
            port: 3000,
            desiredCount: 1,
            // Run on ARM64 so the locally-cached (Apple Silicon) busybox the
            // mirror pushes matches the Fargate runtime architecture.
            runtimePlatform: {
              cpuArchitecture: "ARM64",
              operatingSystemFamily: "LINUX",
            },
            vpcId: net.vpcId as string,
            subnets: azSubnets,
            // Default-VPC public subnets: tasks need a public IP to pull
            // the mirrored image from ECR without a NAT.
            assignPublicIp: true,
            loadBalancer: {
              rules: [{ listen: "80/http" }],
              health: {
                "3000/http": {
                  path: "/health",
                  interval: "15 seconds",
                  successCodes: "200",
                },
              },
            },
            scaling: {
              min: 1,
              max: 2,
              cpuUtilization: 70,
              requestCount: 500,
              scaleInCooldown: "2 minutes",
            },
            secrets: {
              PHASE2_PARAM: parameter.parameterArn,
              PHASE2_SECRET: secret.secretArn,
            },
            logging: { retention: "3 days" },
          });
          return {
            url: service.url.as<string>(),
            serviceName: service.serviceName.as<string>(),
            clusterArn: service.clusterArn.as<string>(),
            loadBalancerArn: service.loadBalancerArn.as<string>(),
            targetGroupArn: service.targetGroupArn.as<string>(),
            logGroupName: service.logGroupName.as<string>(),
          };
        }),
      );

      expect(deployed.url).toMatch(/^http:\/\//);

      // ── live round-trip: /health (the overridden TG path) + /secrets ──
      const fetchRoute = (path: string) =>
        client
          .get(`${deployed.url}${path}`)
          .pipe(
            Effect.flatMap((res) =>
              Effect.map(res.text, (body) => ({ status: res.status, body })),
            ),
          );
      const awaitRoute = (path: string, predicate: (body: string) => boolean) =>
        fetchRoute(path).pipe(
          Effect.flatMap(({ status, body }) =>
            status === 200 && predicate(body)
              ? Effect.succeed(body)
              : Effect.fail(new RouteMismatch({ path, status, body })),
          ),
          // ALB provisioning (~2 min) + image mirror + Fargate start.
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
        );

      yield* awaitRoute("/health", (body) => body.includes("ok"));
      const secretsBody = yield* awaitRoute("/secrets", (body) =>
        body.includes("true"),
      );
      const seen = JSON.parse(secretsBody) as {
        param: boolean;
        secret: boolean;
      };
      expect(seen.param).toBe(true);
      expect(seen.secret).toBe(true);
      // The secret VALUES never leave the container.
      expect(secretsBody).not.toContain("phase2-parameter-value");
      expect(secretsBody).not.toContain("phase2-secret-value");

      // ── per-TG health override landed on the composed target group ────
      const targetGroups = yield* elbv2.describeTargetGroups({
        TargetGroupArns: [deployed.targetGroupArn],
      });
      const targetGroup = targetGroups.TargetGroups?.[0];
      expect(targetGroup?.HealthCheckPath).toBe("/health");
      expect(targetGroup?.HealthCheckIntervalSeconds).toBe(15);
      expect(targetGroup?.Matcher?.HttpCode).toBe("200");

      // ── scaling: scalable target (min/max) + one policy per metric ────
      const resourceId = `service/alchemy-test-ecs-phase2/${deployed.serviceName}`;
      const targets = yield* aas.describeScalableTargets({
        ServiceNamespace: "ecs",
        ResourceIds: [resourceId],
      });
      const scalableTarget = targets.ScalableTargets?.[0];
      expect(scalableTarget?.MinCapacity).toBe(1);
      expect(scalableTarget?.MaxCapacity).toBe(2);

      const policies = yield* aas.describeScalingPolicies({
        ServiceNamespace: "ecs",
        ResourceId: resourceId,
      });
      const trackingConfigs = (policies.ScalingPolicies ?? []).map(
        (policy) => policy.TargetTrackingScalingPolicyConfiguration,
      );
      expect(trackingConfigs.length).toBe(2);
      const cpuPolicy = trackingConfigs.find(
        (config) =>
          config?.PredefinedMetricSpecification?.PredefinedMetricType ===
          "ECSServiceAverageCPUUtilization",
      );
      expect(cpuPolicy?.TargetValue).toBe(70);
      expect(cpuPolicy?.ScaleInCooldown).toBe(120);
      const requestPolicy = trackingConfigs.find(
        (config) =>
          config?.PredefinedMetricSpecification?.PredefinedMetricType ===
          "ALBRequestCountPerTarget",
      );
      expect(requestPolicy?.TargetValue).toBe(500);
      // ResourceLabel = app/{lb-name}/{lb-id}/targetgroup/{tg-name}/{tg-id}.
      const expectedLabel = `${deployed.loadBalancerArn.slice(
        deployed.loadBalancerArn.indexOf("loadbalancer/") +
          "loadbalancer/".length,
      )}/${deployed.targetGroupArn.slice(
        deployed.targetGroupArn.indexOf("targetgroup/"),
      )}`;
      expect(requestPolicy?.PredefinedMetricSpecification?.ResourceLabel).toBe(
        expectedLabel,
      );

      // ── logging.retention on the auto-created log group ───────────────
      const logGroups = yield* logs.describeLogGroups({
        logGroupNamePrefix: deployed.logGroupName,
      });
      const logGroup = (logGroups.logGroups ?? []).find(
        (group) => group.logGroupName === deployed.logGroupName,
      );
      expect(logGroup?.retentionInDays).toBe(3);

      // ── destroy + zero-orphan proofs ──────────────────────────────────
      yield* stack.destroy();

      const targetsAfter = yield* aas.describeScalableTargets({
        ServiceNamespace: "ecs",
        ResourceIds: [resourceId],
      });
      expect((targetsAfter.ScalableTargets ?? []).length).toBe(0);

      const lbGone = yield* elbv2
        .describeLoadBalancers({
          LoadBalancerArns: [deployed.loadBalancerArn],
        })
        .pipe(
          Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
          Effect.catchTag("LoadBalancerNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(lbGone).toBe(true);

      const logGroupsAfter = yield* logs.describeLogGroups({
        logGroupNamePrefix: deployed.logGroupName,
      });
      expect(
        (logGroupsAfter.logGroups ?? []).some(
          (group) => group.logGroupName === deployed.logGroupName,
        ),
      ).toBe(false);
    }),
  { timeout: 900_000 },
);
