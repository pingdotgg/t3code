import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { BatchGetCommandExecutions } from "./BatchGetCommandExecutions.ts";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";

export const BatchGetCommandExecutionsHttp = Layer.effect(
  BatchGetCommandExecutions,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchGetCommandExecutions",
    operation: codebuild.batchGetCommandExecutions,
    actions: ["codebuild:BatchGetCommandExecutions"],
    sandboxScoped: true,
  }),
);
