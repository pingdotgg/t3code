import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateFindings } from "./UpdateFindings.ts";

export const UpdateFindingsHttp = Layer.effect(
  UpdateFindings,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.UpdateFindings",
    operation: aa.updateFindings,
    actions: ["access-analyzer:UpdateFindings"],
  }),
);
