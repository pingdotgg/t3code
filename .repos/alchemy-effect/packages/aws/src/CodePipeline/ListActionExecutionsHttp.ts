import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { ListActionExecutions } from "./ListActionExecutions.ts";

export const ListActionExecutionsHttp = Layer.effect(
  ListActionExecutions,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.ListActionExecutions",
    operation: codepipeline.listActionExecutions,
    actions: ["codepipeline:ListActionExecutions"],
  }),
);
