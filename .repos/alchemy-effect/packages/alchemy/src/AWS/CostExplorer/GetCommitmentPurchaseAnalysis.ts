import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCommitmentPurchaseAnalysis}.
 */
export interface GetCommitmentPurchaseAnalysisRequest
  extends ce.GetCommitmentPurchaseAnalysisRequest {}

/**
 * Runtime binding for `ce:GetCommitmentPurchaseAnalysis`.
 *
 * Retrieve a commitment purchase analysis result by its
 * `AnalysisId`. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCommitmentPurchaseAnalysisHttp)`.
 * @binding
 * @section Commitment Purchase Analysis
 * @example Read an Analysis Result
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCommitmentPurchaseAnalysis = yield* AWS.CostExplorer.GetCommitmentPurchaseAnalysis();
 *
 * // runtime
 * const result = yield* getCommitmentPurchaseAnalysis({
 *   AnalysisId: analysisId,
 * });
 * const status = result.AnalysisStatus;
 * ```
 */
export interface GetCommitmentPurchaseAnalysis extends Binding.Service<
  GetCommitmentPurchaseAnalysis,
  "AWS.CostExplorer.GetCommitmentPurchaseAnalysis",
  () => Effect.Effect<
    (
      request: GetCommitmentPurchaseAnalysisRequest,
    ) => Effect.Effect<
      ce.GetCommitmentPurchaseAnalysisResponse,
      ce.GetCommitmentPurchaseAnalysisError
    >
  >
> {}

export const GetCommitmentPurchaseAnalysis =
  Binding.Service<GetCommitmentPurchaseAnalysis>(
    "AWS.CostExplorer.GetCommitmentPurchaseAnalysis",
  );
