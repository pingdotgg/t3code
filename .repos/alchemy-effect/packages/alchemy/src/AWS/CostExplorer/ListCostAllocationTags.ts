import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListCostAllocationTags}.
 */
export interface ListCostAllocationTagsRequest
  extends ce.ListCostAllocationTagsRequest {}

/**
 * Runtime binding for `ce:ListCostAllocationTags`.
 *
 * List your cost allocation tags with their activation status —
 * user-defined and AWS-generated. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ListCostAllocationTagsHttp)`.
 * @binding
 * @section Cost Allocation Tags
 * @example List Cost Allocation Tags
 * ```typescript
 * // init — account-level binding takes no resource
 * const listCostAllocationTags = yield* AWS.CostExplorer.ListCostAllocationTags();
 *
 * // runtime
 * const result = yield* listCostAllocationTags();
 * const tags = result.CostAllocationTags;
 * ```
 */
export interface ListCostAllocationTags extends Binding.Service<
  ListCostAllocationTags,
  "AWS.CostExplorer.ListCostAllocationTags",
  () => Effect.Effect<
    (
      request?: ListCostAllocationTagsRequest,
    ) => Effect.Effect<
      ce.ListCostAllocationTagsResponse,
      ce.ListCostAllocationTagsError
    >
  >
> {}

export const ListCostAllocationTags = Binding.Service<ListCostAllocationTags>(
  "AWS.CostExplorer.ListCostAllocationTags",
);
