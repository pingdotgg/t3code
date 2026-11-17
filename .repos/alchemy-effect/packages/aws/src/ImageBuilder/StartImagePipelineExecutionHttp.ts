import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderPipelineHttpBinding } from "./BindingHttp.ts";
import { StartImagePipelineExecution } from "./StartImagePipelineExecution.ts";

export const StartImagePipelineExecutionHttp = Layer.effect(
  StartImagePipelineExecution,
  makeImageBuilderPipelineHttpBinding({
    tag: "AWS.ImageBuilder.StartImagePipelineExecution",
    operation: imagebuilder.startImagePipelineExecution,
    actions: ["imagebuilder:StartImagePipelineExecution"],
  }),
);
