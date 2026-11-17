import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupHttpBinding } from "./BindingHttp.ts";
import { DescribeCodeCoverages } from "./DescribeCodeCoverages.ts";

export const DescribeCodeCoveragesHttp = Layer.effect(
  DescribeCodeCoverages,
  makeCodeBuildReportGroupHttpBinding({
    tag: "AWS.CodeBuild.DescribeCodeCoverages",
    operation: codebuild.describeCodeCoverages,
    actions: ["codebuild:DescribeCodeCoverages"],
  }),
);
