import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupHttpBinding } from "./BindingHttp.ts";
import { DeleteReport } from "./DeleteReport.ts";

export const DeleteReportHttp = Layer.effect(
  DeleteReport,
  makeCodeBuildReportGroupHttpBinding({
    tag: "AWS.CodeBuild.DeleteReport",
    operation: codebuild.deleteReport,
    actions: ["codebuild:DeleteReport"],
  }),
);
