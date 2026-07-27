import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { DeleteBuildBatch } from "./DeleteBuildBatch.ts";

export const DeleteBuildBatchHttp = Layer.effect(
  DeleteBuildBatch,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.DeleteBuildBatch",
    operation: codebuild.deleteBuildBatch,
    actions: ["codebuild:DeleteBuildBatch"],
  }),
);
