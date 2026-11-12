import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { ListAnalyzedResources } from "./ListAnalyzedResources.ts";

export const ListAnalyzedResourcesHttp = Layer.effect(
  ListAnalyzedResources,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListAnalyzedResources",
    operation: aa.listAnalyzedResources,
    actions: ["access-analyzer:ListAnalyzedResources"],
  }),
);
