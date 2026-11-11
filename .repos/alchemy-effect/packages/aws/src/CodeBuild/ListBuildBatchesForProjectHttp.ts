import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectNameHttpBinding } from "./BindingHttp.ts";
import { ListBuildBatchesForProject } from "./ListBuildBatchesForProject.ts";

export const ListBuildBatchesForProjectHttp = Layer.effect(
  ListBuildBatchesForProject,
  makeCodeBuildProjectNameHttpBinding({
    tag: "AWS.CodeBuild.ListBuildBatchesForProject",
    operation: codebuild.listBuildBatchesForProject,
    actions: ["codebuild:ListBuildBatchesForProject"],
  }),
);
