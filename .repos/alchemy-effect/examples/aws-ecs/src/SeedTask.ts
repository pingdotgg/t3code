import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { OrdersTable } from "./infra.ts";

const seedOrders = [
  { id: "1001", customer: "ada", total: 4250 },
  { id: "1002", customer: "grace", total: 1799 },
  { id: "1003", customer: "linus", total: 999 },
];

/**
 * A one-shot `AWS.ECS.Task` in the INLINE EFFECT form: props + an init
 * Effect whose impl returns `{ run }` — a one-shot entry that executes to
 * completion when the container starts, after which the container exits.
 *
 * The Effect program is bundled into a generated image `FROM image`
 * (`main: import.meta.url` names this module as the entrypoint). The
 * `AWS.DynamoDB.PutItem` binding injects the table's name into the
 * container environment and grants `dynamodb:PutItem` on the task role.
 *
 * Nothing runs this task on deploy — it is the target of the
 * `AWS.ECS.RunTask(cluster, SeedTask)` binding the `Api` service exposes at
 * `POST /api/seed`. A task definition is cluster-independent (mirroring
 * `AWS::ECS::TaskDefinition`), so the launch cluster is declared where the
 * launch is bound, not here.
 */
export default AWS.ECS.Task(
  "SeedTask",
  {
    main: import.meta.url,
    // Docker Hub's `oven/bun`; the public.ecr.aws default mirror
    // rate-limits anonymous pulls during local builds.
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    // Build/run on ARM64 so an image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
  },
  Effect.gen(function* () {
    const table = yield* OrdersTable;
    const putItem = yield* AWS.DynamoDB.PutItem(table);

    return {
      // One-shot entry: seed the table, log, exit 0.
      run: Effect.gen(function* () {
        yield* Effect.forEach(
          seedOrders,
          (order) =>
            putItem({
              Item: {
                pk: { S: `order#${order.id}` },
                customer: { S: order.customer },
                total: { N: String(order.total) },
              },
            }),
          { discard: true },
        );
        yield* Effect.log(`seeded ${seedOrders.length} orders`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
);
