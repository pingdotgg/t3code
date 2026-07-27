import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:StartDocumentTextDetection` — start an
 * asynchronous OCR job for a (possibly multi-page) document stored in S3.
 * Poll the returned `JobId` with `GetDocumentTextDetection`. The caller
 * needs `s3:GetObject` on the input bucket.
 *
 * @binding
 * @section Asynchronous Text Detection
 * @example Start a Text Detection Job
 * ```typescript
 * // init
 * const startDocumentTextDetection =
 *   yield* AWS.Textract.StartDocumentTextDetection();
 *
 * // runtime
 * const { JobId } = yield* startDocumentTextDetection({
 *   DocumentLocation: { S3Object: { Bucket: bucketName, Name: "doc.pdf" } },
 * });
 * ```
 */
export interface StartDocumentTextDetection extends Binding.Service<
  StartDocumentTextDetection,
  "AWS.Textract.StartDocumentTextDetection",
  () => Effect.Effect<
    (
      request: textract.StartDocumentTextDetectionRequest,
    ) => Effect.Effect<
      textract.StartDocumentTextDetectionResponse,
      textract.StartDocumentTextDetectionError
    >
  >
> {}
export const StartDocumentTextDetection =
  Binding.Service<StartDocumentTextDetection>(
    "AWS.Textract.StartDocumentTextDetection",
  );
