import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";

export interface DescribeTasksRequest extends Omit<
  ECS.DescribeTasksRequest,
  "cluster"
> {}

export class DescribeTasks extends Binding.Service<
  DescribeTasks,
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: DescribeTasksRequest,
    ) => Effect.Effect<ECS.DescribeTasksResponse, ECS.DescribeTasksError>
  >
>()("AWS.ECS.DescribeTasks") {}

export const DescribeTasksLive = Layer.effect(
  DescribeTasks,
  Effect.gen(function* () {
    const Policy = yield* DescribeTasksPolicy;
    const describeTasks = yield* ECS.describeTasks;

    return Effect.fn(function* (cluster: Cluster) {
      yield* Policy(cluster);
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      return Effect.fn(function* (request: DescribeTasksRequest) {
        return yield* describeTasks({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);

export class DescribeTasksPolicy extends Binding.Policy<
  DescribeTasksPolicy,
  (cluster: Cluster) => Effect.Effect<void>
>()("AWS.ECS.DescribeTasks") {}

export const DescribeTasksPolicyLive = DescribeTasksPolicy.layer.succeed(
  Effect.fn(function* (host, cluster) {
    if (isFunction(host) || isTask(host)) {
      yield* host.bind`Allow(${host}, AWS.ECS.DescribeTasks(${cluster}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["ecs:DescribeTasks"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DescribeTasksPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
