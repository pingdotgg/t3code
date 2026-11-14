import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupHttpBinding } from "./BindingHttp.ts";
import { DescribeTestCases } from "./DescribeTestCases.ts";

export const DescribeTestCasesHttp = Layer.effect(
  DescribeTestCases,
  makeCodeBuildReportGroupHttpBinding({
    tag: "AWS.CodeBuild.DescribeTestCases",
    operation: codebuild.describeTestCases,
    actions: ["codebuild:DescribeTestCases"],
  }),
);
