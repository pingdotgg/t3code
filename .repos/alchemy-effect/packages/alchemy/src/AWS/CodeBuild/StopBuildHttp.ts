import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { StopBuild } from "./StopBuild.ts";

export const StopBuildHttp = Layer.effect(
  StopBuild,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.StopBuild",
    operation: codebuild.stopBuild,
    actions: ["codebuild:StopBuild"],
  }),
);
