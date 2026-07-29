import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:ListDiscoveredResources` — enumerate the
 * resource identifiers (type, id, name) AWS Config has discovered for a
 * resource type, including optionally deleted resources.
 *
 * Provide `Config.ListDiscoveredResourcesHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Discovering Resources
 * @example List Discovered Buckets
 * ```typescript
 * // init — grants config:ListDiscoveredResources
 * const listDiscoveredResources = yield* AWS.Config.ListDiscoveredResources();
 *
 * // runtime
 * const result = yield* listDiscoveredResources({
 *   resourceType: "AWS::S3::Bucket",
 * });
 * console.log(result.resourceIdentifiers);
 * ```
 */
export interface ListDiscoveredResources extends Binding.Service<
  ListDiscoveredResources,
  "AWS.Config.ListDiscoveredResources",
  () => Effect.Effect<
    (
      request: config.ListDiscoveredResourcesRequest,
    ) => Effect.Effect<
      config.ListDiscoveredResourcesResponse,
      config.ListDiscoveredResourcesError
    >
  >
> {}

export const ListDiscoveredResources = Binding.Service<ListDiscoveredResources>(
  "AWS.Config.ListDiscoveredResources",
);
