import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeTasks } from "./DescribeTasks.ts";

export const DescribeTasksHttp = Layer.effect(
  DescribeTasks,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.DescribeTasks",
    operation: ECS.describeTasks,
    actions: ["ecs:DescribeTasks"],
    // `ecs:DescribeTasks` authorizes against the task resource:
    // arn:aws:ecs:{region}:{account}:task/{clusterName}/*
    resources: ["task"],
  }),
);
