import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { CreateAccessPreview } from "./CreateAccessPreview.ts";

export const CreateAccessPreviewHttp = Layer.effect(
  CreateAccessPreview,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.CreateAccessPreview",
    operation: aa.createAccessPreview,
    actions: ["access-analyzer:CreateAccessPreview"],
  }),
);
