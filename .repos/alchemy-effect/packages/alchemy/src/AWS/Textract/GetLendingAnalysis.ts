import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:GetLendingAnalysis` — read the status and
 * per-page extraction results of an asynchronous lending-analysis job
 * started with `StartLendingAnalysis`.
 *
 * @binding
 * @section Asynchronous Lending Analysis
 * @example Poll a Lending Analysis Job
 * ```typescript
 * // init
 * const getLendingAnalysis = yield* AWS.Textract.GetLendingAnalysis();
 *
 * // runtime
 * const result = yield* getLendingAnalysis({ JobId: jobId });
 * const pages = result.Results;
 * ```
 */
export interface GetLendingAnalysis extends Binding.Service<
  GetLendingAnalysis,
  "AWS.Textract.GetLendingAnalysis",
  () => Effect.Effect<
    (
      request: textract.GetLendingAnalysisRequest,
    ) => Effect.Effect<
      textract.GetLendingAnalysisResponse,
      textract.GetLendingAnalysisError
    >
  >
> {}
export const GetLendingAnalysis = Binding.Service<GetLendingAnalysis>(
  "AWS.Textract.GetLendingAnalysis",
);
