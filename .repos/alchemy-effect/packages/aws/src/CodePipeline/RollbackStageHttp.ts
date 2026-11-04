import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { RollbackStage } from "./RollbackStage.ts";

export const RollbackStageHttp = Layer.effect(
  RollbackStage,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.RollbackStage",
    operation: codepipeline.rollbackStage,
    actions: ["codepipeline:RollbackStage"],
    subScoped: true,
  }),
);
