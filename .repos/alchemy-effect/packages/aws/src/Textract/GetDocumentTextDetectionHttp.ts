import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { GetDocumentTextDetection } from "./GetDocumentTextDetection.ts";

export const GetDocumentTextDetectionHttp = Layer.effect(
  GetDocumentTextDetection,
  makeTextractHttpBinding({
    capability: "GetDocumentTextDetection",
    // No resource-level IAM for this action.
    iamActions: ["textract:GetDocumentTextDetection"],
    operation: textract.getDocumentTextDetection,
  }),
);
