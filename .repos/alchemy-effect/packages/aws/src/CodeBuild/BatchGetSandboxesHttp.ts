import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { BatchGetSandboxes } from "./BatchGetSandboxes.ts";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";

export const BatchGetSandboxesHttp = Layer.effect(
  BatchGetSandboxes,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.BatchGetSandboxes",
    operation: codebuild.batchGetSandboxes,
    actions: ["codebuild:BatchGetSandboxes"],
    sandboxScoped: true,
  }),
);
