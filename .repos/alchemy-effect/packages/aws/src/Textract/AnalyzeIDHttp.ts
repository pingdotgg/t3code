import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { AnalyzeID } from "./AnalyzeID.ts";
import { makeTextractHttpBinding } from "./BindingHttp.ts";

export const AnalyzeIDHttp = Layer.effect(
  AnalyzeID,
  makeTextractHttpBinding({
    capability: "AnalyzeID",
    // No resource-level IAM for this action.
    iamActions: ["textract:AnalyzeID"],
    operation: textract.analyzeID,
  }),
);
