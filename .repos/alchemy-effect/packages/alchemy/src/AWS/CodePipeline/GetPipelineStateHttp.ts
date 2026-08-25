import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelineNameHttpBinding } from "./BindingHttp.ts";
import { GetPipelineState } from "./GetPipelineState.ts";

export const GetPipelineStateHttp = Layer.effect(
  GetPipelineState,
  makeCodePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.GetPipelineState",
    operation: codepipeline.getPipelineState,
    actions: ["codepipeline:GetPipelineState"],
  }),
);
