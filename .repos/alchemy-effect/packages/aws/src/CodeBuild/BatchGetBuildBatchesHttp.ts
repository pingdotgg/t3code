import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { BatchGetBuildBatches } from "./BatchGetBuildBatches.ts";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";

export const BatchGetBuildBatchesHttp = Layer.effect(
  BatchGetBuildBatches,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchGetBuildBatches",
    operation: codebuild.batchGetBuildBatches,
    actions: ["codebuild:BatchGetBuildBatches"],
  }),
);
