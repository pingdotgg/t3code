import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { GetStep } from "./GetStep.ts";

export const GetStepHttp = Layer.effect(
  GetStep,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.GetStep",
    operation: deadline.getStep,
    actions: ["deadline:GetStep"],
  }),
);
