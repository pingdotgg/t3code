import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListGroups` operation (IAM action
 * `identitystore:ListGroups`), scoped to one {@link Instance}.
 *
 * Lists the groups in the bound instance's identity store, one page per call (`NextToken` paginates); pass `Filters` to narrow by attribute. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListGroupsHttp)`.
 * @binding
 * @section Looking Up Groups
 * @example Enumerate Groups
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listGroups = yield* AWS.IdentityCenter.ListGroups(instance);
 *
 * // runtime
 * const { Groups } = yield* listGroups({ MaxResults: 50 });
 * console.log(Groups?.map((group) => group.DisplayName));
 * ```
 */
export interface ListGroups extends Binding.Service<
  ListGroups,
  "AWS.IdentityCenter.ListGroups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: Omit<identitystore.ListGroupsRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.ListGroupsResponse,
      identitystore.ListGroupsError
    >
  >
> {}
export const ListGroups = Binding.Service<ListGroups>(
  "AWS.IdentityCenter.ListGroups",
);
