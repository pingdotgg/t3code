import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { StopPipelineExecution } from "./StopPipelineExecution.ts";

export const StopPipelineExecutionHttp = Layer.effect(
  StopPipelineExecution,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.StopPipelineExecution",
    operation: codepipeline.stopPipelineExecution,
    actions: ["codepipeline:StopPipelineExecution"],
  }),
);
