import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DeleteGroupMembership` operation (IAM action
 * `identitystore:DeleteGroupMembership`), scoped to one {@link Instance}.
 *
 * Removes a group membership from the bound instance's identity store by `MembershipId`. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.DeleteGroupMembershipHttp)`.
 * @binding
 * @section Managing Group Memberships
 * @example Remove a User From a Group
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const deleteGroupMembership = yield* AWS.IdentityCenter.DeleteGroupMembership(instance);
 *
 * // runtime
 * yield* deleteGroupMembership({ MembershipId: membershipId });
 * ```
 */
export interface DeleteGroupMembership extends Binding.Service<
  DeleteGroupMembership,
  "AWS.IdentityCenter.DeleteGroupMembership",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        identitystore.DeleteGroupMembershipRequest,
        "IdentityStoreId"
      >,
    ) => Effect.Effect<
      identitystore.DeleteGroupMembershipResponse,
      identitystore.DeleteGroupMembershipError
    >
  >
> {}
export const DeleteGroupMembership = Binding.Service<DeleteGroupMembership>(
  "AWS.IdentityCenter.DeleteGroupMembership",
);
