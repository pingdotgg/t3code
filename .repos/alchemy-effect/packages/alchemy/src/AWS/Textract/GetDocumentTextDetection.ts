import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:GetDocumentTextDetection` — read the
 * status and results of an asynchronous OCR job started with
 * `StartDocumentTextDetection`.
 *
 * @binding
 * @section Asynchronous Text Detection
 * @example Poll a Text Detection Job
 * ```typescript
 * // init
 * const getDocumentTextDetection =
 *   yield* AWS.Textract.GetDocumentTextDetection();
 *
 * // runtime
 * const result = yield* getDocumentTextDetection({ JobId: jobId });
 * const lines = (result.Blocks ?? [])
 *   .filter((b) => b.BlockType === "LINE")
 *   .map((b) => b.Text);
 * ```
 */
export interface GetDocumentTextDetection extends Binding.Service<
  GetDocumentTextDetection,
  "AWS.Textract.GetDocumentTextDetection",
  () => Effect.Effect<
    (
      request: textract.GetDocumentTextDetectionRequest,
    ) => Effect.Effect<
      textract.GetDocumentTextDetectionResponse,
      textract.GetDocumentTextDetectionError
    >
  >
> {}
export const GetDocumentTextDetection =
  Binding.Service<GetDocumentTextDetection>(
    "AWS.Textract.GetDocumentTextDetection",
  );
