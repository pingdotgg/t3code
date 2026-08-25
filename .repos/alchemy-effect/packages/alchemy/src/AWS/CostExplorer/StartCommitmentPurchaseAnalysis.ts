import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link StartCommitmentPurchaseAnalysis}.
 */
export interface StartCommitmentPurchaseAnalysisRequest
  extends ce.StartCommitmentPurchaseAnalysisRequest {}

/**
 * Runtime binding for `ce:StartCommitmentPurchaseAnalysis`.
 *
 * Start an analysis of a planned Savings Plans commitment purchase —
 * projects the cost impact before you buy. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.StartCommitmentPurchaseAnalysisHttp)`.
 * @binding
 * @section Commitment Purchase Analysis
 * @example Analyze a Planned Commitment
 * ```typescript
 * // init — account-level binding takes no resource
 * const startCommitmentPurchaseAnalysis = yield* AWS.CostExplorer.StartCommitmentPurchaseAnalysis();
 *
 * // runtime
 * const result = yield* startCommitmentPurchaseAnalysis({
 *   CommitmentPurchaseAnalysisConfiguration: configuration,
 * });
 * const analysisId = result.AnalysisId;
 * ```
 */
export interface StartCommitmentPurchaseAnalysis extends Binding.Service<
  StartCommitmentPurchaseAnalysis,
  "AWS.CostExplorer.StartCommitmentPurchaseAnalysis",
  () => Effect.Effect<
    (
      request: StartCommitmentPurchaseAnalysisRequest,
    ) => Effect.Effect<
      ce.StartCommitmentPurchaseAnalysisResponse,
      ce.StartCommitmentPurchaseAnalysisError
    >
  >
> {}

export const StartCommitmentPurchaseAnalysis =
  Binding.Service<StartCommitmentPurchaseAnalysis>(
    "AWS.CostExplorer.StartCommitmentPurchaseAnalysis",
  );
