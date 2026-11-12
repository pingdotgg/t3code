import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { StartDocumentTextDetection } from "./StartDocumentTextDetection.ts";

export const StartDocumentTextDetectionHttp = Layer.effect(
  StartDocumentTextDetection,
  makeTextractHttpBinding({
    capability: "StartDocumentTextDetection",
    // No resource-level IAM for this action.
    iamActions: ["textract:StartDocumentTextDetection"],
    operation: textract.startDocumentTextDetection,
  }),
);
