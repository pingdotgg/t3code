import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  OrdersCluster,
  OrdersIngress,
  OrdersNetwork,
  OrdersTable,
} from "./infra.ts";
import SeedTask from "./SeedTask.ts";

/**
 * The orders API: an `AWS.ECS.Service` in the TAGGED form — the class
 * declares the service identity, and the default export is
 * `Api.make(props, impl)`: a Layer pairing the props with an init Effect
 * whose impl returns `{ fetch }`, bundled into a generated image
 * (`main: import.meta.url`). The Service synthesizes its own task
 * definition (task + execution roles, log group, ECR repository) from the
 * same surface as `AWS.ECS.Task`.
 *
 * The stack provides the Layer and yields the class (see `alchemy.run.ts`):
 *
 * ```typescript
 * const api = yield* Api;         // with Effect.provide(ApiLive)
 * ```
 *
 * Ingress is the SHARED listener composed at the stack level (see
 * `src/infra.ts`): this service only adds its own target group and a
 * `path: "/api/*"` listener rule. The explicit `priority: 10` orders it
 * ahead of `Web`'s catch-all `/*` rule.
 *
 * Bindings work exactly as on Lambda:
 * - `AWS.DynamoDB.GetItem` / `Scan` grant read access to the orders table
 *   and inject its name into the container environment.
 * - `AWS.ECS.RunTask(cluster, SeedTask)` grants `ecs:RunTask` on the seed
 *   task's definition (plus `iam:PassRole` on its roles), so
 *   `POST /api/seed` can launch the one-shot seeding task on Fargate. The
 *   cluster is explicit at the binding — a task definition is
 *   cluster-independent.
 */
export class Api extends AWS.ECS.Service<Api>()("Api") {}

export default Api.make(
  // Props are themselves an Effect so they can reference shared resources.
  Effect.gen(function* () {
    const cluster = yield* OrdersCluster;
    const network = yield* OrdersNetwork;
    const { listener } = yield* OrdersIngress;
    return {
      cluster,
      main: import.meta.url,
      image: "oven/bun:1",
      port: 3000,
      cpu: 256,
      memory: 512,
      desiredCount: 1,
      // Build/run on ARM64 so an image built on an Apple Silicon host
      // matches the Fargate runtime architecture (Graviton).
      runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
      },
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      // Public subnets, no NAT: a public IP is required to pull the image.
      assignPublicIp: true,
      loadBalancer: {
        listener,
        rules: [{ path: "/api/*", priority: 10 }],
      },
    };
  }),
  Effect.gen(function* () {
    const table = yield* OrdersTable;
    const network = yield* OrdersNetwork;
    const cluster = yield* OrdersCluster;
    const seedTask = yield* SeedTask;

    const scan = yield* AWS.DynamoDB.Scan(table);
    const getItem = yield* AWS.DynamoDB.GetItem(table);
    // The launch cluster is explicit at the binding — the task definition
    // itself is cluster-independent.
    const runSeedTask = yield* AWS.ECS.RunTask(cluster, seedTask);

    // First public subnet, bound into the environment so the runtime can
    // build the seed task's awsvpc network configuration.
    const SubnetId = yield* network.publicSubnetIds[0]!;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        // GET /api/orders — list everything in the table.
        if (request.method === "GET" && url.pathname === "/api/orders") {
          const result = yield* scan({});
          const orders = (result.Items ?? []).map((item) => ({
            id: item.pk?.S?.replace(/^order#/, ""),
            customer: item.customer?.S,
            total: item.total?.N ? Number(item.total.N) : undefined,
          }));
          return yield* HttpServerResponse.json({
            count: orders.length,
            orders,
          });
        }

        // GET /api/orders/<id> — read one order.
        const match = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
        if (request.method === "GET" && match) {
          const result = yield* getItem({
            Key: { pk: { S: `order#${match[1]}` } },
          });
          if (!result.Item) {
            return yield* HttpServerResponse.json(
              { error: "not found" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({
            id: match[1],
            customer: result.Item.customer?.S,
            total: result.Item.total?.N
              ? Number(result.Item.total.N)
              : undefined,
          });
        }

        // POST /api/seed — launch the one-shot SeedTask on Fargate via the
        // RunTask binding (cluster + task definition ARNs are injected).
        if (request.method === "POST" && url.pathname === "/api/seed") {
          const subnetId = yield* SubnetId;
          const response = yield* runSeedTask({
            launchType: "FARGATE",
            count: 1,
            startedBy: "orders-api-seed",
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: [subnetId],
                // No securityGroups: the VPC default security group applies
                // (all egress — enough to pull from ECR and reach DynamoDB).
                assignPublicIp: "ENABLED",
              },
            },
          });
          return yield* HttpServerResponse.json({
            taskArn: response.tasks?.[0]?.taskArn,
            failures: response.failures ?? [],
          });
        }

        // Everything else — including the ALB health check on "/" (health
        // checks hit the container directly, not through listener rules).
        return yield* HttpServerResponse.json({
          ok: true,
          service: "orders-api",
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.DynamoDB.ScanHttp,
        AWS.DynamoDB.GetItemHttp,
        AWS.ECS.RunTaskHttp,
      ),
    ),
  ),
);
