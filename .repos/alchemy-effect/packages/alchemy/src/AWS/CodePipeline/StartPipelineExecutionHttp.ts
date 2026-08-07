import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelineNameHttpBinding } from "./BindingHttp.ts";
import { StartPipelineExecution } from "./StartPipelineExecution.ts";

export const StartPipelineExecutionHttp = Layer.effect(
  StartPipelineExecution,
  makeCodePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.StartPipelineExecution",
    operation: codepipeline.startPipelineExecution,
    actions: ["codepipeline:StartPipelineExecution"],
  }),
);
