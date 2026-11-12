import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { AnalyzeDocument } from "./AnalyzeDocument.ts";
import { makeTextractHttpBinding } from "./BindingHttp.ts";

export const AnalyzeDocumentHttp = Layer.effect(
  AnalyzeDocument,
  makeTextractHttpBinding({
    capability: "AnalyzeDocument",
    // No resource-level IAM for this action.
    iamActions: ["textract:AnalyzeDocument"],
    operation: textract.analyzeDocument,
  }),
);
