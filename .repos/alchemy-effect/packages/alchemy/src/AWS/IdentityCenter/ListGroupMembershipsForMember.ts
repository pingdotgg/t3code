import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListGroupMembershipsForMember` operation (IAM action
 * `identitystore:ListGroupMembershipsForMember`), scoped to one {@link Instance}.
 *
 * Lists every group a user belongs to in the bound instance's identity store, one page per call (`NextToken` paginates). The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListGroupMembershipsForMemberHttp)`.
 * @binding
 * @section Querying Group Memberships
 * @example Enumerate a User's Groups
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listGroupMembershipsForMember = yield* AWS.IdentityCenter.ListGroupMembershipsForMember(instance);
 *
 * // runtime
 * const { GroupMemberships } = yield* listGroupMembershipsForMember({
 *   MemberId: { UserId: userId },
 * });
 * ```
 */
export interface ListGroupMembershipsForMember extends Binding.Service<
  ListGroupMembershipsForMember,
  "AWS.IdentityCenter.ListGroupMembershipsForMember",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        identitystore.ListGroupMembershipsForMemberRequest,
        "IdentityStoreId"
      >,
    ) => Effect.Effect<
      identitystore.ListGroupMembershipsForMemberResponse,
      identitystore.ListGroupMembershipsForMemberError
    >
  >
> {}
export const ListGroupMembershipsForMember =
  Binding.Service<ListGroupMembershipsForMember>(
    "AWS.IdentityCenter.ListGroupMembershipsForMember",
  );
