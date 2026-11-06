import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { GetAnalyzedResource } from "./GetAnalyzedResource.ts";

export const GetAnalyzedResourceHttp = Layer.effect(
  GetAnalyzedResource,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.GetAnalyzedResource",
    operation: aa.getAnalyzedResource,
    actions: ["access-analyzer:GetAnalyzedResource"],
  }),
);
