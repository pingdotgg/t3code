import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectNameHttpBinding } from "./BindingHttp.ts";
import { StartBuildBatch } from "./StartBuildBatch.ts";

export const StartBuildBatchHttp = Layer.effect(
  StartBuildBatch,
  makeCodeBuildProjectNameHttpBinding({
    tag: "AWS.CodeBuild.StartBuildBatch",
    operation: codebuild.startBuildBatch,
    actions: ["codebuild:StartBuildBatch"],
  }),
);
