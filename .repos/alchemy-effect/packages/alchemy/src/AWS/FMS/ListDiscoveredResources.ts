import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListDiscoveredResources}.
 */
export interface ListDiscoveredResourcesRequest
  extends fms.ListDiscoveredResourcesRequest {}

/**
 * Runtime binding for `fms:ListDiscoveredResources`.
 *
 * Returns an array of resources in the organization's accounts that are available to be associated with a resource set. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListDiscoveredResourcesHttp)`.
 * @binding
 * @section Resource Sets
 * @example Discover Associable Resources
 * ```typescript
 * // init — account-level binding takes no resource
 * const listDiscoveredResources = yield* AWS.FMS.ListDiscoveredResources();
 *
 * // runtime
 * const result = yield* listDiscoveredResources({
 *   MemberAccountIds: [accountId],
 *   ResourceType: "AWS::EC2::Instance",
 * });
 * console.log(result.Items?.length);
 * ```
 */
export interface ListDiscoveredResources extends Binding.Service<
  ListDiscoveredResources,
  "AWS.FMS.ListDiscoveredResources",
  () => Effect.Effect<
    (
      request: ListDiscoveredResourcesRequest,
    ) => Effect.Effect<
      fms.ListDiscoveredResourcesResponse,
      fms.ListDiscoveredResourcesError
    >
  >
> {}

export const ListDiscoveredResources = Binding.Service<ListDiscoveredResources>(
  "AWS.FMS.ListDiscoveredResources",
);
