import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListCommitmentPurchaseAnalyses}.
 */
export interface ListCommitmentPurchaseAnalysesRequest
  extends ce.ListCommitmentPurchaseAnalysesRequest {}

/**
 * Runtime binding for `ce:ListCommitmentPurchaseAnalyses`.
 *
 * List the commitment purchase analyses run in your account. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ListCommitmentPurchaseAnalysesHttp)`.
 * @binding
 * @section Commitment Purchase Analysis
 * @example List Analyses
 * ```typescript
 * // init — account-level binding takes no resource
 * const listCommitmentPurchaseAnalyses = yield* AWS.CostExplorer.ListCommitmentPurchaseAnalyses();
 *
 * // runtime
 * const result = yield* listCommitmentPurchaseAnalyses();
 * const analyses = result.AnalysisSummaryList;
 * ```
 */
export interface ListCommitmentPurchaseAnalyses extends Binding.Service<
  ListCommitmentPurchaseAnalyses,
  "AWS.CostExplorer.ListCommitmentPurchaseAnalyses",
  () => Effect.Effect<
    (
      request?: ListCommitmentPurchaseAnalysesRequest,
    ) => Effect.Effect<
      ce.ListCommitmentPurchaseAnalysesResponse,
      ce.ListCommitmentPurchaseAnalysesError
    >
  >
> {}

export const ListCommitmentPurchaseAnalyses =
  Binding.Service<ListCommitmentPurchaseAnalyses>(
    "AWS.CostExplorer.ListCommitmentPurchaseAnalyses",
  );
