import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { BatchGetBuilds } from "./BatchGetBuilds.ts";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";

export const BatchGetBuildsHttp = Layer.effect(
  BatchGetBuilds,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchGetBuilds",
    operation: codebuild.batchGetBuilds,
    actions: ["codebuild:BatchGetBuilds"],
  }),
);
