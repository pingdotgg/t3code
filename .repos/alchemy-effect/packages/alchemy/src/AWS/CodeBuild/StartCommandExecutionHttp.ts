import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { StartCommandExecution } from "./StartCommandExecution.ts";

export const StartCommandExecutionHttp = Layer.effect(
  StartCommandExecution,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.StartCommandExecution",
    operation: codebuild.startCommandExecution,
    actions: ["codebuild:StartCommandExecution"],
    sandboxScoped: true,
  }),
);
