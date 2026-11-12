import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectNameHttpBinding } from "./BindingHttp.ts";
import { ListBuildsForProject } from "./ListBuildsForProject.ts";

export const ListBuildsForProjectHttp = Layer.effect(
  ListBuildsForProject,
  makeCodeBuildProjectNameHttpBinding({
    tag: "AWS.CodeBuild.ListBuildsForProject",
    operation: codebuild.listBuildsForProject,
    actions: ["codebuild:ListBuildsForProject"],
  }),
);
