import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelinePipelineNameHttpBinding } from "./BindingHttp.ts";
import { PutApprovalResult } from "./PutApprovalResult.ts";

export const PutApprovalResultHttp = Layer.effect(
  PutApprovalResult,
  makeCodePipelinePipelineNameHttpBinding({
    tag: "AWS.CodePipeline.PutApprovalResult",
    operation: codepipeline.putApprovalResult,
    actions: ["codepipeline:PutApprovalResult"],
    subScoped: true,
  }),
);
