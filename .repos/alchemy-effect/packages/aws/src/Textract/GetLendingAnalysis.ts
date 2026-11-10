import type * as textract from "@distilled.cloud/aws/textract";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `textract:GetLendingAnalysis` — read the status and
 * per-page extraction results of an asynchronous lending-analysis job
 * started with `StartLendingAnalysis`.
 *
 * ### Asynchronous Lending Analysis
 * **Example:** Poll a Lending Analysis Job
 * ```typescript
 * // init
 * const getLendingAnalysis = yield* AWS.Textract.GetLendingAnalysis();
 *
 * // runtime
 * const result = yield* getLendingAnalysis({ JobId: jobId });
 * const pages = result.Results;
 * ```
 *
 * @binding
 */
export interface GetLendingAnalysis extends Binding.Service<
  GetLendingAnalysis,
  "AWS.Textract.GetLendingAnalysis",
  () => Effect.Effect<
    (
      request: textract.GetLendingAnalysisRequest,
    ) => Effect.Effect<textract.GetLendingAnalysisResponse, textract.GetLendingAnalysisError>
  >
> {}
export const GetLendingAnalysis = Binding.Service<GetLendingAnalysis>(
  "AWS.Textract.GetLendingAnalysis",
);
