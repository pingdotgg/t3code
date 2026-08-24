import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ListAttributeGroups`.
 *
 * Enumerates all AppRegistry attribute groups the caller can access —
 * useful in discovery/governance functions that inventory application
 * metadata. Account-level: no resource argument. Provide the implementation
 * with `Effect.provide(AWS.AppRegistry.ListAttributeGroupsHttp)`.
 * @binding
 * @section Discovering Attribute Groups
 * @example List the Account's Attribute Groups
 * ```typescript
 * // init — account-level, no resource argument
 * const listAttributeGroups = yield* AWS.AppRegistry.ListAttributeGroups();
 *
 * // runtime
 * const page = yield* listAttributeGroups({ maxResults: 20 });
 * for (const group of page.attributeGroups ?? []) {
 *   console.log(group.name, group.id);
 * }
 * ```
 */
export interface ListAttributeGroups extends Binding.Service<
  ListAttributeGroups,
  "AWS.AppRegistry.ListAttributeGroups",
  () => Effect.Effect<
    (
      request?: appregistry.ListAttributeGroupsRequest,
    ) => Effect.Effect<
      appregistry.ListAttributeGroupsResponse,
      appregistry.ListAttributeGroupsError
    >
  >
> {}

export const ListAttributeGroups = Binding.Service<ListAttributeGroups>(
  "AWS.AppRegistry.ListAttributeGroups",
);
