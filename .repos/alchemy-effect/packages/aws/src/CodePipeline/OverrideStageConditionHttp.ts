import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { OverrideStageCondition } from "./OverrideStageCondition.ts";

export const OverrideStageConditionHttp = Layer.effect(
  OverrideStageCondition,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.OverrideStageCondition",
    operation: codepipeline.overrideStageCondition,
    actions: ["codepipeline:OverrideStageCondition"],
    subScoped: true,
  }),
);
