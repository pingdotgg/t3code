import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { BatchDeleteBuilds } from "./BatchDeleteBuilds.ts";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteBuildsHttp = Layer.effect(
  BatchDeleteBuilds,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchDeleteBuilds",
    operation: codebuild.batchDeleteBuilds,
    actions: ["codebuild:BatchDeleteBuilds"],
  }),
);
