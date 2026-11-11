import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { ListDeployActionExecutionTargets } from "./ListDeployActionExecutionTargets.ts";

export const ListDeployActionExecutionTargetsHttp = Layer.effect(
  ListDeployActionExecutionTargets,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.ListDeployActionExecutionTargets",
    operation: codepipeline.listDeployActionExecutionTargets,
    actions: ["codepipeline:ListDeployActionExecutionTargets"],
    subScoped: true,
  }),
);
