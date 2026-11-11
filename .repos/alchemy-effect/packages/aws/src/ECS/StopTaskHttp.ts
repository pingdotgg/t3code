import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import { StopTask } from "./StopTask.ts";

export const StopTaskHttp = Layer.effect(
  StopTask,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.StopTask",
    operation: ECS.stopTask,
    actions: ["ecs:StopTask"],
    // `ecs:StopTask` authorizes against the task resource:
    // arn:aws:ecs:{region}:{account}:task/{clusterName}/*
    resources: ["task"],
  }),
);
