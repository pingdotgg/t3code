import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:GetDocumentAnalysis` — read the status and
 * results of an asynchronous document-analysis job started with
 * `StartDocumentAnalysis`. Page through large result sets with `NextToken`.
 *
 * ### Asynchronous Document Analysis
 * **Example:** Poll an Analysis Job
 * ```typescript
 * // init
 * const getDocumentAnalysis = yield* AWS.Textract.GetDocumentAnalysis();
 *
 * // runtime
 * const result = yield* getDocumentAnalysis({ JobId: jobId });
 * if (result.JobStatus === "SUCCEEDED") {
 *   const blocks = result.Blocks;
 * }
 * ```
 *
 * @binding
 */
export interface GetDocumentAnalysis extends Binding.Service<
  GetDocumentAnalysis,
  "AWS.Textract.GetDocumentAnalysis",
  () => Effect.Effect<
    (
      request: textract.GetDocumentAnalysisRequest,
    ) => Effect.Effect<
      textract.GetDocumentAnalysisResponse,
      textract.GetDocumentAnalysisError
    >
  >
> {}
export const GetDocumentAnalysis = Binding.Service<GetDocumentAnalysis>(
  "AWS.Textract.GetDocumentAnalysis",
);
