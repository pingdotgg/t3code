import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { AnalyzeID } from "./AnalyzeID.ts";

export const AnalyzeIDHttp = Layer.effect(
  AnalyzeID,
  makeTextractHttpBinding({
    capability: "AnalyzeID",
    // No resource-level IAM for this action.
    iamActions: ["textract:AnalyzeID"],
    operation: textract.analyzeID,
  }),
);
