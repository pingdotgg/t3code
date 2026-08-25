import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:DetectDocumentText` — synchronous OCR that
 * detects lines and words of text in a JPEG, PNG, PDF, or TIFF document.
 *
 * Textract is a pure pay-per-call service with no resource to manage: the
 * binding takes no arguments and grants the function
 * `textract:DetectDocumentText` (the action has no resource-level IAM).
 * Pass the document as raw bytes (`Document.Bytes`) or as an S3 object
 * reference (`Document.S3Object`) — raw distilled types, no marshalling.
 *
 * @binding
 * @section Detecting Document Text
 * @example Detect Text in Document Bytes
 * ```typescript
 * // init
 * const detectDocumentText = yield* AWS.Textract.DetectDocumentText();
 *
 * // runtime
 * const result = yield* detectDocumentText({
 *   Document: { Bytes: documentBytes },
 * });
 * const lines = (result.Blocks ?? [])
 *   .filter((block) => block.BlockType === "LINE")
 *   .map((block) => block.Text);
 * ```
 */
export interface DetectDocumentText extends Binding.Service<
  DetectDocumentText,
  "AWS.Textract.DetectDocumentText",
  () => Effect.Effect<
    (
      request: textract.DetectDocumentTextRequest,
    ) => Effect.Effect<
      textract.DetectDocumentTextResponse,
      textract.DetectDocumentTextError
    >
  >
> {}
export const DetectDocumentText = Binding.Service<DetectDocumentText>(
  "AWS.Textract.DetectDocumentText",
);
