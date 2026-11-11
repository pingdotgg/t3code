import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectNameHttpBinding } from "./BindingHttp.ts";
import { StartBuild } from "./StartBuild.ts";

export const StartBuildHttp = Layer.effect(
  StartBuild,
  makeCodeBuildProjectNameHttpBinding({
    tag: "AWS.CodeBuild.StartBuild",
    operation: codebuild.startBuild,
    actions: ["codebuild:StartBuild"],
  }),
);
