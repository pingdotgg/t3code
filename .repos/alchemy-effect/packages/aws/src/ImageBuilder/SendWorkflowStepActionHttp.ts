import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { SendWorkflowStepAction } from "./SendWorkflowStepAction.ts";

export const SendWorkflowStepActionHttp = Layer.effect(
  SendWorkflowStepAction,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.SendWorkflowStepAction",
    operation: imagebuilder.sendWorkflowStepAction,
    actions: ["imagebuilder:SendWorkflowStepAction"],
  }),
);
