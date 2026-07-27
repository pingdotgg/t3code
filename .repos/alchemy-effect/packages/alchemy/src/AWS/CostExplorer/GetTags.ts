import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetTags}.
 */
export interface GetTagsRequest extends ce.GetTagsRequest {}

/**
 * Runtime binding for `ce:GetTags`.
 *
 * Retrieve the cost allocation tag keys (or the values of one key)
 * present in your cost data over a time period. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetTagsHttp)`.
 * @binding
 * @section Exploring Dimensions and Tags
 * @example List Cost Allocation Tag Values
 * ```typescript
 * // init — account-level binding takes no resource
 * const getTags = yield* AWS.CostExplorer.GetTags();
 *
 * // runtime
 * const result = yield* getTags({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * const keys = result.Tags;
 * ```
 */
export interface GetTags extends Binding.Service<
  GetTags,
  "AWS.CostExplorer.GetTags",
  () => Effect.Effect<
    (
      request: GetTagsRequest,
    ) => Effect.Effect<ce.GetTagsResponse, ce.GetTagsError>
  >
> {}

export const GetTags = Binding.Service<GetTags>("AWS.CostExplorer.GetTags");
