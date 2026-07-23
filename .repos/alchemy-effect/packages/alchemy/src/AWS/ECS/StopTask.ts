import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";

export interface StopTaskRequest extends Omit<ECS.StopTaskRequest, "cluster"> {}

export class StopTask extends Binding.Service<
  StopTask,
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: StopTaskRequest,
    ) => Effect.Effect<ECS.StopTaskResponse, ECS.StopTaskError>
  >
>()("AWS.ECS.StopTask") {}

export const StopTaskLive = Layer.effect(
  StopTask,
  Effect.gen(function* () {
    const Policy = yield* StopTaskPolicy;
    const stopTask = yield* ECS.stopTask;

    return Effect.fn(function* (cluster: Cluster) {
      yield* Policy(cluster);
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      return Effect.fn(function* (request: StopTaskRequest) {
        return yield* stopTask({
          ...request,
          cluster: clusterArn,
        });
      });
    });
  }),
);

export class StopTaskPolicy extends Binding.Policy<
  StopTaskPolicy,
  (cluster: Cluster) => Effect.Effect<void>
>()("AWS.ECS.StopTask") {}

export const StopTaskPolicyLive = StopTaskPolicy.layer.succeed(
  Effect.fn(function* (host, cluster) {
    if (isFunction(host) || isTask(host)) {
      yield* host.bind`Allow(${host}, AWS.ECS.StopTask(${cluster}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["ecs:StopTask"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `StopTaskPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
