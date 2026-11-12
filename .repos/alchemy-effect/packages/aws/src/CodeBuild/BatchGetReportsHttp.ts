import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { BatchGetReports } from "./BatchGetReports.ts";
import { makeCodeBuildReportGroupHttpBinding } from "./BindingHttp.ts";

export const BatchGetReportsHttp = Layer.effect(
  BatchGetReports,
  makeCodeBuildReportGroupHttpBinding({
    tag: "AWS.CodeBuild.BatchGetReports",
    operation: codebuild.batchGetReports,
    actions: ["codebuild:BatchGetReports"],
  }),
);
