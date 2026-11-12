import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectNameHttpBinding } from "./BindingHttp.ts";
import { ListSandboxesForProject } from "./ListSandboxesForProject.ts";

export const ListSandboxesForProjectHttp = Layer.effect(
  ListSandboxesForProject,
  makeCodeBuildProjectNameHttpBinding({
    tag: "AWS.CodeBuild.ListSandboxesForProject",
    operation: codebuild.listSandboxesForProject,
    actions: ["codebuild:ListSandboxesForProject"],
  }),
);
