import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { Task, isTask } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";

export interface RunTaskRequest extends Omit<
  ECS.RunTaskRequest,
  "cluster" | "taskDefinition"
> {}

export class RunTask extends Binding.Service<
  RunTask,
  (
    cluster: Cluster,
    task: Task,
  ) => Effect.Effect<
    (
      request: RunTaskRequest,
    ) => Effect.Effect<ECS.RunTaskResponse, ECS.RunTaskError>
  >
>()("AWS.ECS.RunTask") {}

export const RunTaskLive = Layer.effect(
  RunTask,
  Effect.gen(function* () {
    const Policy = yield* RunTaskPolicy;
    const runTask = yield* ECS.runTask;

    return Effect.fn(function* (cluster: Cluster, task: Task) {
      yield* Policy(cluster, task);
      const clusterArn = (yield* cluster.clusterArn) as unknown as string;
      const taskDefinitionArn =
        (yield* task.taskDefinitionArn) as unknown as string;

      return Effect.fn(function* (request: RunTaskRequest) {
        return yield* runTask({
          ...request,
          cluster: clusterArn,
          taskDefinition: taskDefinitionArn,
        });
      });
    });
  }),
);

export class RunTaskPolicy extends Binding.Policy<
  RunTaskPolicy,
  (cluster: Cluster, task: Task) => Effect.Effect<void>
>()("AWS.ECS.RunTask") {}

export const RunTaskPolicyLive = RunTaskPolicy.layer.succeed(
  Effect.fn(function* (host, cluster, task) {
    if (isFunction(host) || isTask(host)) {
      yield* host.bind`Allow(${host}, AWS.ECS.RunTask(${cluster}, ${task}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["ecs:RunTask"],
            Resource: [task.taskDefinitionArn],
          },
          {
            Effect: "Allow",
            Action: ["iam:PassRole"],
            Resource: [task.taskRoleArn, task.executionRoleArn],
          },
          {
            Effect: "Allow",
            Action: ["ecs:DescribeTasks"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `RunTaskPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
