import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { UpdateStep } from "./UpdateStep.ts";

export const UpdateStepHttp = Layer.effect(
  UpdateStep,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.UpdateStep",
    operation: deadline.updateStep,
    actions: ["deadline:UpdateStep"],
  }),
);
