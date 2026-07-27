import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListGroupMemberships` operation (IAM action
 * `identitystore:ListGroupMemberships`), scoped to one {@link Instance}.
 *
 * Lists the members of a group in the bound instance's identity store, one page per call (`NextToken` paginates). The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListGroupMembershipsHttp)`.
 * @binding
 * @section Querying Group Memberships
 * @example Enumerate a Group's Members
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listGroupMemberships = yield* AWS.IdentityCenter.ListGroupMemberships(instance);
 *
 * // runtime
 * const { GroupMemberships } = yield* listGroupMemberships({
 *   GroupId: groupId,
 * });
 * ```
 */
export interface ListGroupMemberships extends Binding.Service<
  ListGroupMemberships,
  "AWS.IdentityCenter.ListGroupMemberships",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        identitystore.ListGroupMembershipsRequest,
        "IdentityStoreId"
      >,
    ) => Effect.Effect<
      identitystore.ListGroupMembershipsResponse,
      identitystore.ListGroupMembershipsError
    >
  >
> {}
export const ListGroupMemberships = Binding.Service<ListGroupMemberships>(
  "AWS.IdentityCenter.ListGroupMemberships",
);
