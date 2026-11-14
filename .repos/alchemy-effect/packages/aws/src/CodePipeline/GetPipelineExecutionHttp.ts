import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { GetPipelineExecution } from "./GetPipelineExecution.ts";

export const GetPipelineExecutionHttp = Layer.effect(
  GetPipelineExecution,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.GetPipelineExecution",
    operation: codepipeline.getPipelineExecution,
    actions: ["codepipeline:GetPipelineExecution"],
  }),
);
