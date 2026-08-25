import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { BatchGetBuildBatches } from "./BatchGetBuildBatches.ts";

export const BatchGetBuildBatchesHttp = Layer.effect(
  BatchGetBuildBatches,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchGetBuildBatches",
    operation: codebuild.batchGetBuildBatches,
    actions: ["codebuild:BatchGetBuildBatches"],
  }),
);
