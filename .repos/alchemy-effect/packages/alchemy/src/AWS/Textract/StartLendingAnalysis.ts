import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:StartLendingAnalysis` — start an
 * asynchronous lending-document analysis job (classifies pages and routes
 * them to the right extraction model) for a document stored in S3. Poll
 * the returned `JobId` with `GetLendingAnalysis` /
 * `GetLendingAnalysisSummary`. The caller needs `s3:GetObject` on the
 * input bucket.
 *
 * ### Asynchronous Lending Analysis
 * **Example:** Start a Lending Analysis Job
 * ```typescript
 * // init
 * const startLendingAnalysis = yield* AWS.Textract.StartLendingAnalysis();
 *
 * // runtime
 * const { JobId } = yield* startLendingAnalysis({
 *   DocumentLocation: { S3Object: { Bucket: bucketName, Name: "loan.pdf" } },
 * });
 * ```
 *
 * @binding
 */
export interface StartLendingAnalysis extends Binding.Service<
  StartLendingAnalysis,
  "AWS.Textract.StartLendingAnalysis",
  () => Effect.Effect<
    (
      request: textract.StartLendingAnalysisRequest,
    ) => Effect.Effect<
      textract.StartLendingAnalysisResponse,
      textract.StartLendingAnalysisError
    >
  >
> {}
export const StartLendingAnalysis = Binding.Service<StartLendingAnalysis>(
  "AWS.Textract.StartLendingAnalysis",
);
