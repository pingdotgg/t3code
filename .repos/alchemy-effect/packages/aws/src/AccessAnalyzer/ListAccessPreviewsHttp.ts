import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { ListAccessPreviews } from "./ListAccessPreviews.ts";

export const ListAccessPreviewsHttp = Layer.effect(
  ListAccessPreviews,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListAccessPreviews",
    operation: aa.listAccessPreviews,
    actions: ["access-analyzer:ListAccessPreviews"],
  }),
);
