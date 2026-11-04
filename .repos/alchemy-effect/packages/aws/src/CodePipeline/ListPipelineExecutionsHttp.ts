import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { ListPipelineExecutions } from "./ListPipelineExecutions.ts";

export const ListPipelineExecutionsHttp = Layer.effect(
  ListPipelineExecutions,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.ListPipelineExecutions",
    operation: codepipeline.listPipelineExecutions,
    actions: ["codepipeline:ListPipelineExecutions"],
  }),
);
