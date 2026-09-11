import * as AWS from "@/AWS";
import { SecurityGroup } from "@/AWS/EC2";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import type { OtelSink } from "./fixtures/otel-collector-worker.ts";
import TestTask from "./fixtures/task.ts";
import {
  E2E_CLUSTER_NAME,
  E2E_TEST_TITLE,
  reclaimTaskE2EOrphans,
  scanTaskE2EOrphans,
} from "./reclaimTaskE2EOrphans.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

// The OTLP sink the task exports to (a workers.dev URL is reachable from
// Fargate). Declared identically in both deploy steps so the second deploy
// keeps it.
const collectorMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/otel-collector-worker.ts",
);
const collectorWorker = () =>
  Cloudflare.Worker("EcsOtelCollector", {
    main: collectorMain,
    env: {
      SINK: Cloudflare.DurableObject<OtelSink>("OtelSink"),
    },
    compatibility: { date: "2024-09-23" },
  });

// Full end-to-end: build + push the bundled Task image, run it on Fargate
// behind an Alchemy-managed public ALB, and prove over HTTP that (a) the
// `{ fetch }` handler is served and (b) the `ServerHost.run` background loop is
// actually executing inside the deployed container (`/ticks` keeps climbing).
//
// This is the real-deploy regression for #706. Docker/ECR + Fargate placement
// + the ALB health ramp takes about five minutes even on the standing default
// VPC, so keep it out of the hard-240 default sweep. Run it explicitly with
// `AWS_TEST_SLOW=1`; `FAST=1` always keeps the lifecycle disabled.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  // The title doubles as the scratch stack name, which prefixes every
  // physical name — the orphan sweep prefix-matches on it.
  E2E_TEST_TITLE,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The scratch stack's state is in-memory, so a hard-killed prior run
      // (vitest hard timeout / OOM) orphans everything it deployed — the
      // engine can never see it again. Reclaim those leftovers up front, and
      // guarantee the same sweep runs on success, failure, AND interruption.
      yield* reclaimTaskE2EOrphans;
      yield* Effect.addFinalizer(() =>
        reclaimTaskE2EOrphans.pipe(Effect.orDie),
      );

      // Reuse the standing public network. Creating a dedicated VPC here is
      // both unnecessary for the Task regression and races the account's VPC
      // quota during c128 sweeps. An internet-facing ALB needs two AZs.
      const { vpcId, subnetIds } = yield* getDefaultVpcNetwork;
      if (subnetIds.length < 2) {
        return yield* Effect.die(
          new Error("default VPC has fewer than 2 subnets"),
        );
      }
      const publicSubnetIds = subnetIds.slice(0, 2);

      // Deploy the OTLP collector first: the task fixture resolves
      // `COLLECTOR_URL` from the deployer's config at deploy time.
      const collector = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* collectorWorker();
        }),
      );
      const collected = `${collector.url}/collected`;

      const currentConfig = yield* ConfigProvider.ConfigProvider;
      const {
        url,
        targetGroupArn,
        clusterArn,
        serviceName,
        taskDefinitionArn,
      } = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* collectorWorker();
            // The default VPC supplies public routing and subnets; this managed
            // security group remains isolated to the test and is swept exactly.
            const securityGroup = yield* SecurityGroup("EcsE2ESg", {
              vpcId,
              description: "alchemy ecs task e2e",
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 80,
                  toPort: 80,
                  cidrIpv4: "0.0.0.0/0",
                  description: "ALB ingress",
                },
                {
                  ipProtocol: "tcp",
                  fromPort: 3000,
                  toPort: 3000,
                  cidrIpv4: "0.0.0.0/0",
                  description: "container traffic",
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

            const cluster = yield* Cluster("EcsE2ECluster", {
              clusterName: E2E_CLUSTER_NAME,
            });

            // The bundled long-running Task (builds + pushes the image).
            const task = yield* TestTask;

            const service = yield* Service("EcsE2EService", {
              cluster,
              task: {
                taskDefinitionArn: task.taskDefinitionArn,
                containerName: task.containerName,
                port: task.port,
              },
              desiredCount: 1,
              public: true,
              listenerPort: 80,
              healthCheckPath: "/health",
              vpcId,
              subnets: publicSubnetIds,
              securityGroups: [securityGroup.groupId],
              assignPublicIp: true,
            });

            return {
              url: service.url,
              targetGroupArn: service.targetGroupArn,
              clusterArn: service.clusterArn,
              serviceName: service.serviceName,
              taskDefinitionArn: service.taskDefinitionArn,
            };
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ COLLECTOR_URL: collector.url }),
              currentConfig,
            ),
          ),
        );

      expect(url).toBeTruthy();
      expect(targetGroupArn).toBeTruthy();

      // Service.deploy now blocks until the exact task definition is the sole
      // completed deployment, ECS counts have settled, and every registered
      // target is healthy. Prove that contract immediately out-of-band.
      const describedService = yield* ecs.describeServices({
        cluster: clusterArn,
        services: [serviceName],
      });
      const deployedService = describedService.services?.[0];
      expect(deployedService?.taskDefinition).toBe(taskDefinitionArn);
      expect(deployedService?.desiredCount).toBe(1);
      expect(deployedService?.runningCount).toBe(1);
      expect(deployedService?.pendingCount).toBe(0);
      expect(deployedService?.deployments).toHaveLength(1);
      expect(deployedService?.deployments?.[0]?.status).toBe("PRIMARY");

      const targetHealth = yield* elbv2.describeTargetHealth({
        TargetGroupArn: targetGroupArn!,
      });
      expect(
        (targetHealth.TargetHealthDescriptions ?? []).map(
          (target) => target.TargetHealth?.State,
        ),
      ).toEqual(["healthy"]);

      // The ALB has been active for a while now, so its DNS resolves. Probe the
      // public endpoint (still retry through edge/DNS propagation).
      const health = yield* HttpClient.get(`${url}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health returned ${res.status}`)),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 30 }),
      );
      expect(health.status).toBe(200);
      expect(yield* health.json).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing in-container:
      // the tick counter climbs between two reads.
      const readTicks = HttpClient.get(`${url}/ticks`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      yield* Effect.sleep("3 seconds");
      const second = yield* readTicks;
      expect(second).toBeGreaterThan(first);

      // Process-mode telemetry: spans from SEPARATE requests must arrive in
      // one batched traces payload (interval batching on the process root
      // scope) — a per-request flush would put each span in its own POST
      // and the pair would never share a payload item. Retry attempts with
      // fresh tags in case a pair straddles a 5s export window.
      const fetchCollected = HttpClient.get(collected).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map(
          (body) =>
            (body as { items: { signal: string; payload: unknown }[] }).items,
        ),
      );
      const attemptBatch = (i: number) =>
        Effect.gen(function* () {
          yield* HttpClient.get(`${url}/work?tag=a${i}`);
          yield* HttpClient.get(`${url}/work?tag=b${i}`);
          return yield* fetchCollected.pipe(
            Effect.map((items) =>
              items.some((item) => {
                if (item.signal !== "traces") return false;
                const payload = JSON.stringify(item.payload);
                return (
                  payload.includes(`work:a${i}`) &&
                  payload.includes(`work:b${i}`)
                );
              }),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (found): boolean => found,
              times: 8,
            }),
            Effect.catchCause(() => Effect.succeed(false)),
          );
        });
      let batched = false;
      for (let i = 0; i < 3 && !batched; i++) {
        batched = yield* attemptBatch(i);
      }
      expect(batched).toBe(true);

      // Logs from the same requests ship through the process-mode logger.
      const items = yield* fetchCollected;
      expect(
        items.some(
          (item) =>
            item.signal === "logs" &&
            JSON.stringify(item.payload).includes("ecs-work-log:"),
        ),
      ).toBe(true);
      // And the process-mode resource attributes are stamped.
      expect(JSON.stringify(items)).toContain("otel-ecs-e2e");

      yield* stack.destroy();

      // Sweep the stragglers `stack.destroy()` cannot reach: the INACTIVE
      // task-definition revisions left by `deregisterTaskDefinition`, plus
      // anything a partial destroy failure abandoned. This is what makes a
      // PASSING run leave zero cloud resources behind.
      yield* reclaimTaskE2EOrphans;

      // Clean-slate proof: a passing run leaves ZERO cloud resources.
      expect(yield* scanTaskE2EOrphans).toEqual([]);
    }),
  { timeout: 1_200_000 },
);
