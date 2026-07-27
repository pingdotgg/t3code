import * as AWS from "@/AWS";
import { SecurityGroup } from "@/AWS/EC2";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { Service } from "@/AWS/ECS/Service.ts";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import TestTask from "./fixtures/task.ts";
import {
  E2E_CLUSTER_NAME,
  E2E_TEST_TITLE,
  reclaimTaskE2EOrphans,
  scanTaskE2EOrphans,
} from "./reclaimTaskE2EOrphans.ts";

const { test } = Test.make({ providers: AWS.providers() });

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

      const { url, targetGroupArn } = yield* stack.deploy(
        Effect.gen(function* () {
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
          };
        }),
      );

      expect(url).toBeTruthy();
      expect(targetGroupArn).toBeTruthy();

      // Gate on target health via the ELBv2 API (no DNS): wait until the task
      // is placed, the image pulled, and the ALB health check on `/health`
      // passes. Polling via the API — rather than HTTP — avoids looking up the
      // freshly-created ALB hostname before its DNS record exists (a premature
      // lookup gets NXDOMAIN negatively cached by the resolver for minutes).
      yield* elbv2
        .describeTargetHealth({ TargetGroupArn: targetGroupArn! })
        .pipe(
          Effect.flatMap((result) => {
            const states = (result.TargetHealthDescriptions ?? []).map(
              (t) => t.TargetHealth?.State,
            );
            return states.includes("healthy")
              ? Effect.void
              : Effect.fail(
                  new Error(`no healthy target yet: [${states.join(", ")}]`),
                );
          }),
          Effect.tapError((error) => Effect.logError(error)),
          // ~12 min budget: image pull + container boot + the ALB health check
          // ramp (default 5 × 30s consecutive successes) can take several
          // minutes for a cold Fargate task.
          Effect.retry({ schedule: Schedule.spaced("12 seconds"), times: 60 }),
        );

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
