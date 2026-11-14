import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsTaskLaunchHttpBinding } from "./BindingHttp.ts";
import { RunTask } from "./RunTask.ts";

export const RunTaskHttp = Layer.effect(
  RunTask,
  makeEcsTaskLaunchHttpBinding({
    tag: "AWS.ECS.RunTask",
    operation: ECS.runTask,
    actions: ["ecs:RunTask"],
  }),
);
