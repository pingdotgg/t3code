import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link StartCostAllocationTagBackfill}.
 */
export interface StartCostAllocationTagBackfillRequest
  extends ce.StartCostAllocationTagBackfillRequest {}

/**
 * Runtime binding for `ce:StartCostAllocationTagBackfill`.
 *
 * Backfill cost allocation tag activation status to past billing
 * periods (allowed once every 24 hours). Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.StartCostAllocationTagBackfillHttp)`.
 * @binding
 * @section Cost Allocation Tags
 * @example Backfill Tag Activation
 * ```typescript
 * // init — account-level binding takes no resource
 * const startCostAllocationTagBackfill = yield* AWS.CostExplorer.StartCostAllocationTagBackfill();
 *
 * // runtime
 * const result = yield* startCostAllocationTagBackfill({
 *   BackfillFrom: "2026-01-01T00:00:00Z",
 * });
 * ```
 */
export interface StartCostAllocationTagBackfill extends Binding.Service<
  StartCostAllocationTagBackfill,
  "AWS.CostExplorer.StartCostAllocationTagBackfill",
  () => Effect.Effect<
    (
      request: StartCostAllocationTagBackfillRequest,
    ) => Effect.Effect<
      ce.StartCostAllocationTagBackfillResponse,
      ce.StartCostAllocationTagBackfillError
    >
  >
> {}

export const StartCostAllocationTagBackfill =
  Binding.Service<StartCostAllocationTagBackfill>(
    "AWS.CostExplorer.StartCostAllocationTagBackfill",
  );
