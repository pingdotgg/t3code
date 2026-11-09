import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeActivityArnHttpBinding } from "./BindingHttp.ts";
import { GetActivityTask } from "./GetActivityTask.ts";

export const GetActivityTaskHttp = Layer.effect(
  GetActivityTask,
  makeActivityArnHttpBinding({
    tag: "AWS.StepFunctions.GetActivityTask",
    operation: sfn.getActivityTask,
    actions: ["states:GetActivityTask"],
  }),
);
