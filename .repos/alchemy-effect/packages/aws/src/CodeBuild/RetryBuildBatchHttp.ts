import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { RetryBuildBatch } from "./RetryBuildBatch.ts";

export const RetryBuildBatchHttp = Layer.effect(
  RetryBuildBatch,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.RetryBuildBatch",
    operation: codebuild.retryBuildBatch,
    actions: ["codebuild:RetryBuildBatch"],
  }),
);
