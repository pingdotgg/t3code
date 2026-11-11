import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { DisableStageTransition } from "./DisableStageTransition.ts";

export const DisableStageTransitionHttp = Layer.effect(
  DisableStageTransition,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.DisableStageTransition",
    operation: codepipeline.disableStageTransition,
    actions: ["codepipeline:DisableStageTransition"],
    subScoped: true,
  }),
);
