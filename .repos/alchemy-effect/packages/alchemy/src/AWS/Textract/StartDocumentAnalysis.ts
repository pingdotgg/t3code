import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:StartDocumentAnalysis` — start an
 * asynchronous analysis job for a (possibly multi-page) document stored in
 * S3. Poll the returned `JobId` with `GetDocumentAnalysis`, or pass a
 * `NotificationChannel` to receive the completion event on an SNS topic
 * (pair it with an SNS event source to invoke a Function on completion).
 * The caller needs `s3:GetObject` on the input bucket.
 *
 * @binding
 * @section Asynchronous Document Analysis
 * @example Start an Analysis Job
 * ```typescript
 * // init
 * const startDocumentAnalysis = yield* AWS.Textract.StartDocumentAnalysis();
 *
 * // runtime
 * const { JobId } = yield* startDocumentAnalysis({
 *   DocumentLocation: { S3Object: { Bucket: bucketName, Name: "doc.pdf" } },
 *   FeatureTypes: ["TABLES"],
 * });
 * ```
 */
export interface StartDocumentAnalysis extends Binding.Service<
  StartDocumentAnalysis,
  "AWS.Textract.StartDocumentAnalysis",
  () => Effect.Effect<
    (
      request: textract.StartDocumentAnalysisRequest,
    ) => Effect.Effect<
      textract.StartDocumentAnalysisResponse,
      textract.StartDocumentAnalysisError
    >
  >
> {}
export const StartDocumentAnalysis = Binding.Service<StartDocumentAnalysis>(
  "AWS.Textract.StartDocumentAnalysis",
);
