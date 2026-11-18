import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { GetAccessPreview } from "./GetAccessPreview.ts";

export const GetAccessPreviewHttp = Layer.effect(
  GetAccessPreview,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.GetAccessPreview",
    operation: aa.getAccessPreview,
    actions: ["access-analyzer:GetAccessPreview"],
  }),
);
