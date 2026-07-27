import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { PutActionRevision } from "./PutActionRevision.ts";

export const PutActionRevisionHttp = Layer.effect(
  PutActionRevision,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.PutActionRevision",
    operation: codepipeline.putActionRevision,
    actions: ["codepipeline:PutActionRevision"],
    subScoped: true,
  }),
);
