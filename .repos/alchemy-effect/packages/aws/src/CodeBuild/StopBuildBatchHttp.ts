import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { StopBuildBatch } from "./StopBuildBatch.ts";

export const StopBuildBatchHttp = Layer.effect(
  StopBuildBatch,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.StopBuildBatch",
    operation: codebuild.stopBuildBatch,
    actions: ["codebuild:StopBuildBatch"],
  }),
);
