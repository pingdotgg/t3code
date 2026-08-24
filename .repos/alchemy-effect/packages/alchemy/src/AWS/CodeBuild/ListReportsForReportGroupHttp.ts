import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Layer from "effect/Layer";
import { makeCodeBuildReportGroupArnHttpBinding } from "./BindingHttp.ts";
import { ListReportsForReportGroup } from "./ListReportsForReportGroup.ts";

export const ListReportsForReportGroupHttp = Layer.effect(
  ListReportsForReportGroup,
  makeCodeBuildReportGroupArnHttpBinding({
    tag: "AWS.CodeBuild.ListReportsForReportGroup",
    operation: codebuild.listReportsForReportGroup,
    actions: ["codebuild:ListReportsForReportGroup"],
  }),
);
