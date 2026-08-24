import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:StartExpenseAnalysis` — start an
 * asynchronous invoice/receipt analysis job for a document stored in S3.
 * Poll the returned `JobId` with `GetExpenseAnalysis`. The caller needs
 * `s3:GetObject` on the input bucket.
 *
 * @binding
 * @section Asynchronous Expense Analysis
 * @example Start an Expense Analysis Job
 * ```typescript
 * // init
 * const startExpenseAnalysis = yield* AWS.Textract.StartExpenseAnalysis();
 *
 * // runtime
 * const { JobId } = yield* startExpenseAnalysis({
 *   DocumentLocation: { S3Object: { Bucket: bucketName, Name: "invoice.pdf" } },
 * });
 * ```
 */
export interface StartExpenseAnalysis extends Binding.Service<
  StartExpenseAnalysis,
  "AWS.Textract.StartExpenseAnalysis",
  () => Effect.Effect<
    (
      request: textract.StartExpenseAnalysisRequest,
    ) => Effect.Effect<
      textract.StartExpenseAnalysisResponse,
      textract.StartExpenseAnalysisError
    >
  >
> {}
export const StartExpenseAnalysis = Binding.Service<StartExpenseAnalysis>(
  "AWS.Textract.StartExpenseAnalysis",
);
