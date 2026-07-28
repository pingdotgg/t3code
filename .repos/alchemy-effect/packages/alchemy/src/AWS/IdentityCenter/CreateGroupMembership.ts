import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `CreateGroupMembership` operation (IAM action
 * `identitystore:CreateGroupMembership`), scoped to one {@link Instance}.
 *
 * Adds a user to a group in the bound instance's identity store, returning the new `MembershipId`. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.CreateGroupMembershipHttp)`.
 * @binding
 * @section Managing Group Memberships
 * @example Add a User to a Group
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const createGroupMembership = yield* AWS.IdentityCenter.CreateGroupMembership(instance);
 *
 * // runtime
 * const { MembershipId } = yield* createGroupMembership({
 *   GroupId: groupId,
 *   MemberId: { UserId: userId },
 * });
 * ```
 */
export interface CreateGroupMembership extends Binding.Service<
  CreateGroupMembership,
  "AWS.IdentityCenter.CreateGroupMembership",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        identitystore.CreateGroupMembershipRequest,
        "IdentityStoreId"
      >,
    ) => Effect.Effect<
      identitystore.CreateGroupMembershipResponse,
      identitystore.CreateGroupMembershipError
    >
  >
> {}
export const CreateGroupMembership = Binding.Service<CreateGroupMembership>(
  "AWS.IdentityCenter.CreateGroupMembership",
);
