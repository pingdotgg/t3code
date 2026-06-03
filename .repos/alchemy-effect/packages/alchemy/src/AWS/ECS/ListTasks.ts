import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";

export interface ListTasksRequest extends Omit<
  ECS.ListTasksRequest,
  "cluster"
> {}

export class ListTasks extends Binding.Service<
  ListTasks,
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ListTasksRequest,
    ) => Effect.Effect<ECS.ListTasksResponse, ECS.ListTasksError>
  >
>()("AWS.ECS.ListTasks") {}

export const ListTasksLive = Layer.effect(
  ListTasks,
  Effect.gen(function* () {
    const Policy = yield* ListTasksPolicy;
    const listTasks = yield* ECS.listTasks;

    return Effect.fn(function* (cluster: Cluster) {
      yield* Policy(cluster);
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      return Effect.fn(function* (request: ListTasksRequest) {
        return yield* listTasks({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);

export class ListTasksPolicy extends Binding.Policy<
  ListTasksPolicy,
  (cluster: Cluster) => Effect.Effect<void>
>()("AWS.ECS.ListTasks") {}

export const ListTasksPolicyLive = ListTasksPolicy.layer.succeed(
  Effect.fn(function* (host, cluster) {
    if (isFunction(host) || isTask(host)) {
      yield* host.bind`Allow(${host}, AWS.ECS.ListTasks(${cluster}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["ecs:ListTasks"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListTasksPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
