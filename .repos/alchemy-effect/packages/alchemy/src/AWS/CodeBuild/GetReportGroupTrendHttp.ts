import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupArnHttpBinding } from "./BindingHttp.ts";
import { GetReportGroupTrend } from "./GetReportGroupTrend.ts";

export const GetReportGroupTrendHttp = Layer.effect(
  GetReportGroupTrend,
  makeCodeBuildReportGroupArnHttpBinding({
    tag: "AWS.CodeBuild.GetReportGroupTrend",
    operation: codebuild.getReportGroupTrend,
    actions: ["codebuild:GetReportGroupTrend"],
  }),
);
