import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:GetDiscoveredResourceCounts` — count the
 * resources AWS Config has discovered, grouped by resource type.
 *
 * Provide `Config.GetDiscoveredResourceCountsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Discovering Resources
 * @example Count Discovered Resources
 * ```typescript
 * // init — grants config:GetDiscoveredResourceCounts
 * const getDiscoveredResourceCounts = yield* AWS.Config.GetDiscoveredResourceCounts();
 *
 * // runtime
 * const result = yield* getDiscoveredResourceCounts();
 * console.log(result.totalDiscoveredResources, result.resourceCounts);
 * ```
 */
export interface GetDiscoveredResourceCounts extends Binding.Service<
  GetDiscoveredResourceCounts,
  "AWS.Config.GetDiscoveredResourceCounts",
  () => Effect.Effect<
    (
      request?: config.GetDiscoveredResourceCountsRequest,
    ) => Effect.Effect<
      config.GetDiscoveredResourceCountsResponse,
      config.GetDiscoveredResourceCountsError
    >
  >
> {}

export const GetDiscoveredResourceCounts =
  Binding.Service<GetDiscoveredResourceCounts>(
    "AWS.Config.GetDiscoveredResourceCounts",
  );
