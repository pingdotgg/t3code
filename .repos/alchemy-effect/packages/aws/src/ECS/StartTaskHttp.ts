import * as ECS from "@distilled.cloud/aws/ecs";
import * as Layer from "effect/Layer";
import { makeEcsTaskLaunchHttpBinding } from "./BindingHttp.ts";
import { StartTask } from "./StartTask.ts";

export const StartTaskHttp = Layer.effect(
  StartTask,
  makeEcsTaskLaunchHttpBinding({
    tag: "AWS.ECS.StartTask",
    operation: ECS.startTask,
    actions: ["ecs:StartTask"],
  }),
);
