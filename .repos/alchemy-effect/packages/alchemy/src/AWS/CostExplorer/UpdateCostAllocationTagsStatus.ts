import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link UpdateCostAllocationTagsStatus}.
 */
export interface UpdateCostAllocationTagsStatusRequest
  extends ce.UpdateCostAllocationTagsStatusRequest {}

/**
 * Runtime binding for `ce:UpdateCostAllocationTagsStatus`.
 *
 * Activate or deactivate cost allocation tag keys in bulk (max 20
 * per call). Activation makes the tag usable in cost queries, categories,
 * and CUR reports. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.UpdateCostAllocationTagsStatusHttp)`.
 * @binding
 * @section Cost Allocation Tags
 * @example Activate a Tag Key
 * ```typescript
 * // init — account-level binding takes no resource
 * const updateCostAllocationTagsStatus = yield* AWS.CostExplorer.UpdateCostAllocationTagsStatus();
 *
 * // runtime
 * yield* updateCostAllocationTagsStatus({
 *   CostAllocationTagsStatus: [{ TagKey: "team", Status: "Active" }],
 * });
 * ```
 */
export interface UpdateCostAllocationTagsStatus extends Binding.Service<
  UpdateCostAllocationTagsStatus,
  "AWS.CostExplorer.UpdateCostAllocationTagsStatus",
  () => Effect.Effect<
    (
      request: UpdateCostAllocationTagsStatusRequest,
    ) => Effect.Effect<
      ce.UpdateCostAllocationTagsStatusResponse,
      ce.UpdateCostAllocationTagsStatusError
    >
  >
> {}

export const UpdateCostAllocationTagsStatus =
  Binding.Service<UpdateCostAllocationTagsStatus>(
    "AWS.CostExplorer.UpdateCostAllocationTagsStatus",
  );
