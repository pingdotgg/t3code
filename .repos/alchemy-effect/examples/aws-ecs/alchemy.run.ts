/**
 * An "orders" app on ECS Fargate that exercises the full container surface:
 *
 * - a stack-owned SHARED ALB + HTTP listener (`src/infra.ts`) that two
 *   services attach path rules to,
 * - `Api` — an effectful `AWS.ECS.Service` (bundled `main:` image source)
 *   serving `/api/*` with DynamoDB + `RunTask` bindings (`src/Api.ts`),
 * - `Web` — an EXTERNAL `AWS.ECS.Service` (registry `image:` source, no
 *   Effect runtime in the container) serving the catch-all `/*`,
 * - `SeedTask` — an inline-effect one-shot `AWS.ECS.Task` (`{ run }`) that
 *   seeds the orders table, launched from `POST /api/seed` (`src/SeedTask.ts`),
 * - `ReportTask` — an external one-shot task built from a local Dockerfile
 *   (`context:` image source, `src/report/Dockerfile`),
 * - `HeartbeatTask` — an external one-shot task on an EventBridge cron
 *   schedule via `AWS.ECS.every`.
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import ApiLive, { Api } from "./src/Api.ts";
import {
  OrdersCluster,
  OrdersIngress,
  OrdersNetwork,
  OrdersTable,
} from "./src/infra.ts";

export default Alchemy.Stack(
  "AwsEcsExample",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const network = yield* OrdersNetwork;
    const cluster = yield* OrdersCluster;
    const table = yield* OrdersTable;
    const { alb, listener } = yield* OrdersIngress;

    // ── Api — effectful service in the TAGGED form (bundled `main:`),
    // /api/* on the shared ALB. `ApiLive` (the `Api.make(...)` Layer,
    // provided below) carries the props + init program; its init also
    // declares SeedTask (for the RunTask binding) and the DynamoDB
    // bindings; see src/Api.ts.
    const api = yield* Api;

    // ── Web — EXTERNAL service: a pre-built registry image (mirrored into
    // ECR), no Effect runtime in the container. Attaches the catch-all `/*`
    // rule to the shared listener; the explicit priority orders it AFTER
    // Api's `/api/*` rule (lower number evaluates first).
    const web = yield* AWS.ECS.Service("Web", {
      cluster,
      image: "nginxdemos/hello:plain-text",
      port: 80,
      desiredCount: 1,
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      assignPublicIp: true,
      loadBalancer: {
        listener,
        rules: [{ path: "/*", priority: 20000 }],
      },
    });

    // ── ReportTask — EXTERNAL one-shot task built from the example's own
    // Dockerfile (`context:` image source; `dockerfile` defaults to
    // `${context}/Dockerfile`). Deploy builds + pushes the image and
    // registers the task definition; run it with `RunTask` or a schedule.
    const reportTask = yield* AWS.ECS.Task("ReportTask", {
      context: `${import.meta.dirname}/src/report`,
      cpu: 256,
      memory: 512,
      // Build/run on ARM64 so an image built on an Apple Silicon host
      // matches the Fargate runtime architecture (Graviton).
      runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
      },
    });

    // ── HeartbeatTask — EXTERNAL one-shot task (registry `image:` source)
    // run nightly by an EventBridge Scheduler cron via `AWS.ECS.every`
    // (which provisions the schedule plus the ecs:RunTask invoke role).
    const heartbeatTask = yield* AWS.ECS.Task("HeartbeatTask", {
      image: "busybox:stable",
      command: ["sh", "-c", "echo orders heartbeat"],
      cpu: 256,
      memory: 512,
    });
    yield* AWS.ECS.every("HeartbeatSchedule", "cron(0 3 * * ? *)", {
      cluster,
      task: heartbeatTask,
      subnets: network.publicSubnetIds,
      assignPublicIp: true,
    });

    return {
      url: Output.interpolate`http://${alb.dnsName}`,
      apiUrl: Output.interpolate`http://${alb.dnsName}/api/orders`,
      seedUrl: Output.interpolate`http://${alb.dnsName}/api/seed`,
      tableName: table.tableName,
      apiServiceName: api.serviceName,
      webServiceName: web.serviceName,
      reportTaskDefinitionArn: reportTask.taskDefinitionArn,
      heartbeatTaskDefinitionArn: heartbeatTask.taskDefinitionArn,
    };
  }).pipe(Effect.provide(ApiLive)),
);
