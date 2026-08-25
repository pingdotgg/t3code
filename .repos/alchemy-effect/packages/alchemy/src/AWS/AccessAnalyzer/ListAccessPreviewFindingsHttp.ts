import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { ListAccessPreviewFindings } from "./ListAccessPreviewFindings.ts";

export const ListAccessPreviewFindingsHttp = Layer.effect(
  ListAccessPreviewFindings,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListAccessPreviewFindings",
    operation: aa.listAccessPreviewFindings,
    actions: ["access-analyzer:ListAccessPreviewFindings"],
  }),
);
