import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import { BatchGetCommandExecutions } from "./BatchGetCommandExecutions.ts";

export const BatchGetCommandExecutionsHttp = Layer.effect(
  BatchGetCommandExecutions,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchGetCommandExecutions",
    operation: codebuild.batchGetCommandExecutions,
    actions: ["codebuild:BatchGetCommandExecutions"],
    sandboxScoped: true,
  }),
);
